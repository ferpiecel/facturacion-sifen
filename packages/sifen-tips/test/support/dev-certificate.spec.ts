import forge from 'node-forge';
import { describe, expect, it } from 'vitest';
import { generateDevCertificate } from './dev-certificate.ts';

describe('generateDevCertificate', () => {
  it('returns a PKCS#12 buffer decodable with the same password, never touching disk', () => {
    const cert = generateDevCertificate();

    expect(cert.p12).toBeInstanceOf(Uint8Array);
    expect(cert.p12.length).toBeGreaterThan(0);

    const p12Der = forge.util.binary.raw.encode(cert.p12);
    const p12Asn1 = forge.asn1.fromDer(p12Der);
    const p12 = forge.pkcs12.pkcs12FromAsn1(p12Asn1, cert.password);

    expect(p12.safeContents.length).toBeGreaterThan(0);
  });

  it('generates a fresh key pair (and thus a different certificate) on every call', () => {
    const first = generateDevCertificate();
    const second = generateDevCertificate();

    expect(Buffer.from(first.p12)).not.toEqual(Buffer.from(second.p12));
  });
});
