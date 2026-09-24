import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeSifenGateway, type QrConfig } from '@sifen/sifen-gateway';
import { validateXml } from '@sifen/sifen-xsd';
import { generateDevCertificate } from './support/dev-certificate.ts';
import { installNoSubprocessGuard, restoreNoSubprocessGuard, getGuardCallCount } from './support/no-subprocess-guard.ts';
import { pocFacturaInput } from './fixtures/poc-factura-input.ts';
import type { TipsDeXmlBuilder, TipsQrGenerator, TipsXmlSigner } from '../src/index.ts';

const QR_CONFIG: QrConfig = {
  idCsc: '0001',
  csc: 'ABCD0000000000000000000000000000',
  ambiente: 'test',
};

/**
 * Full offline PoC flow: build → sign (Node-mode) → QR → XSD validate →
 * FakeSifenGateway, entirely offline (ADR-0015, HU-E0-04). The guard is
 * installed before the adapters are dynamically imported, so any
 * `child_process` reference the TIPS libraries would read at module-load
 * time is trapped too.
 */
describe('Offline PoC: build → sign → QR → XSD validate → FakeSifenGateway', () => {
  let builder: TipsDeXmlBuilder;
  let signer: TipsXmlSigner;
  let qrGenerator: TipsQrGenerator;

  async function runFullFlow(): Promise<string> {
    const cert = generateDevCertificate();
    const xml = await builder.buildParaSifen(pocFacturaInput);
    const signedXml = await signer.sign(xml, cert);
    return qrGenerator.addQr(signedXml, QR_CONFIG);
  }

  beforeAll(async () => {
    installNoSubprocessGuard();
    const adapters = await import('../src/index.ts');
    builder = new adapters.TipsDeXmlBuilder();
    signer = new adapters.TipsXmlSigner();
    qrGenerator = new adapters.TipsQrGenerator();
  });

  afterAll(() => {
    restoreNoSubprocessGuard();
  });

  it('validates the signed, QR-annotated DE against siRecepDE with no network access', async () => {
    const signedXmlWithQr = await runFullFlow();

    const result = validateXml(signedXmlWithQr, 'siRecepDE');

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('signs with exc-c14n + rsa-sha256 + sha256, a certificate-only KeyInfo, and Reference URI #<DE Id>', async () => {
    const signedXmlWithQr = await runFullFlow();

    expect(signedXmlWithQr).toMatch(
      /<CanonicalizationMethod Algorithm="http:\/\/www\.w3\.org\/2001\/10\/xml-exc-c14n#"/,
    );
    expect(signedXmlWithQr).toMatch(
      /<SignatureMethod Algorithm="http:\/\/www\.w3\.org\/2001\/04\/xmldsig-more#rsa-sha256"/,
    );
    expect(signedXmlWithQr).toMatch(
      /<DigestMethod Algorithm="http:\/\/www\.w3\.org\/2001\/04\/xmlenc#sha256"/,
    );

    const keyInfoMatch = signedXmlWithQr.match(/<KeyInfo>([\s\S]*?)<\/KeyInfo>/);
    expect(keyInfoMatch).not.toBeNull();
    const keyInfoContent = keyInfoMatch?.[1] ?? '';
    expect(keyInfoContent).toContain('<X509Certificate>');
    expect(keyInfoContent).not.toMatch(/<X509IssuerSerial>|<X509SubjectName>|<X509SKI>|<X509CRL>/);

    const deIdMatch = signedXmlWithQr.match(/<DE Id="([^"]+)"/);
    const referenceUriMatch = signedXmlWithQr.match(/<Reference URI="([^"]+)"/);
    expect(deIdMatch).not.toBeNull();
    expect(referenceUriMatch).not.toBeNull();
    const deId = deIdMatch?.[1] ?? '';
    expect(referenceUriMatch?.[1]).toBe(`#${deId}`);
  });

  it('embeds a QR pointing at the test consultas endpoint with IdCSC=0001', async () => {
    const signedXmlWithQr = await runFullFlow();

    const qrUrlMatch = signedXmlWithQr.match(
      /https:\/\/ekuatia\.set\.gov\.py\/consultas-test\/qr\?[^<]*/,
    );

    expect(qrUrlMatch).not.toBeNull();
    expect(qrUrlMatch?.[0]).toContain('IdCSC=0001');
  });

  it('documents ADR-0015 open questions D7/D8 as observed facts of this generated document', async () => {
    const signedXmlWithQr = await runFullFlow();

    // D7: dSisFact is present in the xmlgen output (open question: confirm
    // the expected value/usage in sifen-test, not asserted here).
    expect(signedXmlWithQr).toMatch(/<dSisFact>/);
    // D8: the Reference carries exactly two Transforms (enveloped-signature,
    // exc-c14n) — open question was whether SIFEN expects only one.
    const transformCount = (signedXmlWithQr.match(/<Transform /g) ?? []).length;
    expect(transformCount).toBe(2);
  });

  it('sends the exact signed and QR-annotated XML to FakeSifenGateway.enviarLote and receives 0300', async () => {
    const signedXmlWithQr = await runFullFlow();
    const gateway = new FakeSifenGateway();

    const receipt = await gateway.enviarLote({ dId: 1n, des: [signedXmlWithQr] });

    expect(receipt.dCodRes).toBe('0300');
    expect(gateway.callsTo('enviarLote')).toEqual([[{ dId: 1n, des: [signedXmlWithQr] }]]);
  });

  it('never spawns a subprocess anywhere in the flow (guard recorded zero calls)', async () => {
    await runFullFlow();

    expect(getGuardCallCount()).toBe(0);
  });
});
