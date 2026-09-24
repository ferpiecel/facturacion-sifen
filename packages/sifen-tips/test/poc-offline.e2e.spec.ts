import forge from 'node-forge';
import { SignedXml } from 'xml-crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeSifenGateway, type LoadedCertificate, type QrConfig } from '@sifen/sifen-gateway';
import { validateXml } from '@sifen/sifen-xsd';
import { generateDevCertificate } from './support/dev-certificate.ts';
import { getGuardCallCount, restoreNoSubprocessGuard } from './support/no-subprocess-guard.ts';
import { pocFacturaInput } from './fixtures/poc-factura-input.ts';

const QR_CONFIG: QrConfig = {
  idCsc: '0001',
  csc: 'ABCD0000000000000000000000000000',
  ambiente: 'test',
};

/**
 * Extracts the dev certificate's X.509 public certificate as PEM, so
 * xml-crypto can verify against the same key pair that signed the XML.
 */
function certPemFrom(cert: LoadedCertificate): string {
  const binary = Buffer.from(cert.p12).toString('binary');
  const asn1 = forge.asn1.fromDer(forge.util.createBuffer(binary, 'raw'));
  const bags = forge.pkcs12
    .pkcs12FromAsn1(asn1, false, cert.password)
    .getBags({ bagType: forge.pki.oids.certBag });
  const certificate = bags[forge.pki.oids.certBag]?.[0]?.cert;
  if (!certificate) throw new Error('dev certificate PKCS#12 has no X.509 certificate');
  return forge.pki.certificateToPem(certificate);
}

/** Verifies the enveloped-signature + exc-c14n XMLDSig `<Signature>` against `cert`'s public key. */
function signatureVerifies(xml: string, cert: LoadedCertificate): boolean {
  const signatureXml = xml.match(/<Signature[\s\S]*?<\/Signature>/)?.[0];
  if (!signatureXml) return false;
  const sig = new SignedXml({ publicCert: certPemFrom(cert) });
  sig.loadSignature(signatureXml);
  return sig.checkSignature(xml);
}

/**
 * Full offline PoC flow: build → sign (Node-mode) → QR → XSD validate →
 * FakeSifenGateway, entirely offline (ADR-0015, HU-E0-04). The `e2e` Vitest
 * project's setupFiles entry installs the no-subprocess guard before this
 * file (and the TIPS libraries it transitively loads) is imported at all, so
 * even a `child_process` reference captured at require time is trapped.
 * The flow runs once; every `it` below asserts on the same resulting document.
 */
describe('Offline PoC: build → sign → QR → XSD validate → FakeSifenGateway', () => {
  let signedXml: string;
  let signedXmlWithQr: string;
  let cert: LoadedCertificate;

  beforeAll(async () => {
    const { TipsDeXmlBuilder, TipsQrGenerator, TipsXmlSigner } = await import('../src/index.ts');

    cert = generateDevCertificate();
    const xml = await new TipsDeXmlBuilder().buildParaSifen(pocFacturaInput);
    signedXml = await new TipsXmlSigner().sign(xml, cert);
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

  it('verifies the XMLDSig signature against the dev certificate public key, and rejects a tampered digit', () => {
    expect(signatureVerifies(signedXml, cert)).toBe(true);

    // Mutation check: one digit of a signed element's text flips, so this is
    // not a vacuous "any signature verifies" assertion.
    const tampered = signedXml.replace(/(<dRucEm>)(\d)/, (_, open: string, digit: string) =>
      digit === '9' ? `${open}8` : `${open}9`,
    );
    expect(tampered).not.toBe(signedXml);
    expect(signatureVerifies(tampered, cert)).toBe(false);
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
