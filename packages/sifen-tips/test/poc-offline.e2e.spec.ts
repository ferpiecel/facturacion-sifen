import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeSifenGateway, type QrConfig } from '@sifen/sifen-gateway';
import { validateXml } from '@sifen/sifen-xsd';
import { generateDevCertificate } from './support/dev-certificate.ts';
import {
  getGuardCallCount,
  installNoSubprocessGuard,
  restoreNoSubprocessGuard,
} from './support/no-subprocess-guard.ts';
import { pocFacturaInput } from './fixtures/poc-factura-input.ts';

const QR_CONFIG: QrConfig = {
  idCsc: '0001',
  csc: 'ABCD0000000000000000000000000000',
  ambiente: 'test',
};

/**
 * Full offline PoC flow: build → sign (Node-mode) → QR → XSD validate →
 * FakeSifenGateway, entirely offline (ADR-0015, HU-E0-04). The guard is
 * installed before the adapters are dynamically imported (module load
 * happens in `beforeAll`), so any `child_process` reference the TIPS
 * libraries would read at that time is trapped too. The flow runs once;
 * every `it` below asserts on the same resulting document.
 */
describe('Offline PoC: build → sign → QR → XSD validate → FakeSifenGateway', () => {
  let signedXmlWithQr: string;

  beforeAll(async () => {
    installNoSubprocessGuard();
    const { TipsDeXmlBuilder, TipsQrGenerator, TipsXmlSigner } = await import('../src/index.ts');

    const cert = generateDevCertificate();
    const xml = await new TipsDeXmlBuilder().buildParaSifen(pocFacturaInput);
    const signedXml = await new TipsXmlSigner().sign(xml, cert);
    signedXmlWithQr = await new TipsQrGenerator().addQr(signedXml, QR_CONFIG);
  });

  afterAll(() => {
    restoreNoSubprocessGuard();
  });

  it('validates against siRecepDE, with no network access and zero child_process calls', () => {
    const result = validateXml(signedXmlWithQr, 'siRecepDE');

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(getGuardCallCount()).toBe(0);
  });

  it('signs with exc-c14n + rsa-sha256 + sha256, a certificate-only KeyInfo, and Reference URI #<DE Id>', () => {
    expect(signedXmlWithQr).toMatch(/<CanonicalizationMethod Algorithm="[^"]*exc-c14n#"/);
    expect(signedXmlWithQr).toMatch(/<SignatureMethod Algorithm="[^"]*rsa-sha256"/);
    expect(signedXmlWithQr).toMatch(/<DigestMethod Algorithm="[^"]*xmlenc#sha256"/);

    const keyInfo = signedXmlWithQr.match(/<KeyInfo>([\s\S]*?)<\/KeyInfo>/)?.[1] ?? '';
    expect(keyInfo).toContain('<X509Certificate>');
    expect(keyInfo).not.toMatch(/<X509IssuerSerial>|<X509SubjectName>|<X509SKI>|<X509CRL>/);

    const deId = signedXmlWithQr.match(/<DE Id="([^"]+)"/)?.[1] ?? '';
    expect(deId).not.toBe('');
    expect(signedXmlWithQr.match(/<Reference URI="([^"]+)"/)?.[1]).toBe(`#${deId}`);

    // ADR-0015 open questions, documented as observed facts, not requirements:
    // D7 — dSisFact is present; D8 — Reference carries exactly two Transforms.
    expect(signedXmlWithQr).toMatch(/<dSisFact>/);
    expect(signedXmlWithQr.match(/<Transform /g)).toHaveLength(2);
  });

  it('embeds a QR pointing at the test consultas endpoint with IdCSC=0001', () => {
    const qrUrl = signedXmlWithQr.match(
      /https:\/\/ekuatia\.set\.gov\.py\/consultas-test\/qr\?[^<]*/,
    );

    expect(qrUrl).not.toBeNull();
    expect(qrUrl?.[0]).toContain('IdCSC=0001');
  });

  it('sends the exact signed and QR-annotated XML to FakeSifenGateway.enviarLote and receives 0300', async () => {
    const gateway = new FakeSifenGateway();

    const receipt = await gateway.enviarLote({ dId: 1n, des: [signedXmlWithQr] });

    expect(receipt.dCodRes).toBe('0300');
    expect(gateway.callsTo('enviarLote')).toEqual([[{ dId: 1n, des: [signedXmlWithQr] }]]);
  });
});
