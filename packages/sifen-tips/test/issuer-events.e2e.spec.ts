import forge from 'node-forge';
import { SignedXml } from 'xml-crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { IssuerEvent, LoadedCertificate } from '@sifen/sifen-gateway';
import { generateDevCertificate } from './support/dev-certificate.ts';
import { getGuardCallCount, restoreNoSubprocessGuard } from './support/no-subprocess-guard.ts';

const CDC = '01800000019001001000000112026101310000000019';
const SIFEN_NS = 'http://ekuatia.set.gov.py/sifen/xsd';

const CANCEL: IssuerEvent = { kind: 'cancellation', cdc: CDC, reason: 'Error en los datos' };
const VOID: IssuerEvent = {
  kind: 'voiding',
  timbrado: '12345678',
  establishment: '001',
  expeditionPoint: '001',
  from: 3,
  to: 9,
  documentType: 1,
  reason: 'Numeros sin uso',
};

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

/** The batch the gateway sends: the signed events, in a `dEvReg`, under the default SIFEN namespace. */
const batchOf = (...events: string[]): string =>
  `<rEnviEventoDe xmlns="${SIFEN_NS}"><dId>1</dId><dEvReg>${events.join('')}</dEvReg></rEnviEventoDe>`;

/** Checks every `Signature` of the batch against `cert`'s public key. */
function allSignaturesVerify(xml: string, cert: LoadedCertificate): boolean {
  const signatures = xml.match(/<Signature[\s\S]*?<\/Signature>/g) ?? [];
  return (
    signatures.length > 0 &&
    signatures.every((signatureXml) => {
      const sig = new SignedXml({ publicCert: certPemFrom(cert) });
      sig.loadSignature(signatureXml);
      try {
        return sig.checkSignature(xml);
      } catch {
        // xml-crypto throws when the signature value does not match the key.
        return false;
      }
    })
  );
}

/**
 * HU-E8-04 slice A (ADR-0020): build and sign issuer events offline, with the real TIPS libraries and a
 * development certificate, and check that the signatures survive the move from the library's envelope to
 * the batch envelope of the gateway. The e2e project installs the no-subprocess guard first.
 */
describe('Issuer events: TipsEventXmlBuilder + TipsEventSigner', () => {
  const cert = generateDevCertificate();
  let signedCancel: string;
  let signedVoid: string;

  beforeAll(async () => {
    const { TipsEventSigner, TipsEventXmlBuilder } = await import('../src/index.ts');
    const builder = new TipsEventXmlBuilder();
    const signer = new TipsEventSigner();
    signedCancel = await signer.sign(await builder.build({ eventId: 11, event: CANCEL }), cert);
    signedVoid = await signer.sign(await builder.build({ eventId: 12, event: VOID }), cert);
  });

  afterAll(() => {
    restoreNoSubprocessGuard();
  });

  it('signs rEve and places the Signature right after it, referencing our event id', () => {
    expect(signedCancel).toMatch(/<\/rEve><Signature [^>]*>.*<\/Signature><\/rGesEve>/s);
    expect(signedCancel).toContain('<Reference URI="#11">');
    expect(signedVoid).toContain('<Reference URI="#12">');
    expect(getGuardCallCount()).toBe(0);
  });

  it('verifies once embedded in the batch envelope, one event and a mixed batch of two', () => {
    expect(allSignaturesVerify(batchOf(signedCancel), cert)).toBe(true);
    expect(allSignaturesVerify(batchOf(signedCancel, signedVoid), cert)).toBe(true);
  });

  it('fails verification when the signed content is altered', () => {
    const tampered = signedCancel.replace('Error en los datos', 'Otro motivo cualquiera');

    expect(allSignaturesVerify(batchOf(tampered), cert)).toBe(false);
  });

  it('fails verification against another certificate', () => {
    expect(allSignaturesVerify(batchOf(signedCancel), generateDevCertificate())).toBe(false);
  });

  it('keeps the event content untouched by signing', () => {
    expect(signedCancel).toContain(`<rGeVeCan><Id>${CDC}</Id><mOtEve>Error en los datos</mOtEve>`);
    expect(signedVoid).toContain('<dNumIn>0000003</dNumIn><dNumFin>0000009</dNumFin>');
  });
});
