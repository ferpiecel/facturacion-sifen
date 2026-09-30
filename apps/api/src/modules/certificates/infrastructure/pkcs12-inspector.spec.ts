import { generateKeyPairSync, X509Certificate } from 'node:crypto';
import forge from 'node-forge';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  createTestAuthority,
  issueTestPkcs12,
  type TestAuthority,
} from '../../../../test/support/test-pki.js';
import { parseRuc } from '../../fiscal-config/domain/ruc.js';
import {
  Pkcs12ContentError,
  Pkcs12UnreadableError,
  validateTenantCertificate,
} from '../domain/tenant-certificate.js';
import { inspectPkcs12 } from './pkcs12-inspector.js';

let psc: TestAuthority;

beforeAll(() => {
  psc = createTestAuthority('Test PSC Root');
});

describe('inspectPkcs12 (HU-E3-01)', () => {
  it('opens a tenant .p12 and picks the certificate matching its private key', () => {
    const { p12, password, leafPem } = issueTestPkcs12(psc, { serialNumber: 'RUC80000005-6' });

    const inspection = inspectPkcs12(p12, password);

    expect(inspection.certificate.fingerprint256).toBe(new X509Certificate(leafPem).fingerprint256);
    expect(inspection.chain.map((cert) => cert.fingerprint256)).toEqual([
      new X509Certificate(psc.pem).fingerprint256,
    ]);
    expect(inspection.subjectRuc).toEqual(parseRuc('80000005-6'));
    expect(
      validateTenantCertificate(inspection, {
        tenantRuc: parseRuc('80000005-6'),
        now: new Date(),
        trustedPscRoots: [new X509Certificate(psc.pem)],
      }),
    ).toEqual([]);
  });

  it('never exposes the private key', () => {
    const { p12, password } = issueTestPkcs12(psc, { serialNumber: 'RUC80000005-6' });
    expect(Object.keys(inspectPkcs12(p12, password))).not.toContain('privateKey');
  });

  it('rejects a wrong password with a typed error that echoes nothing', () => {
    const { p12, password } = issueTestPkcs12(psc, {}, 'right-password-123');

    const attempt = () => inspectPkcs12(p12, 'wrong-password-456');

    expect(attempt).toThrow(Pkcs12UnreadableError);
    try {
      attempt();
    } catch (error) {
      expect((error as Error).message).not.toMatch(/password-\d/);
      expect((error as Error).message).not.toContain(password);
      expect((error as Error).cause).toBeUndefined();
    }
  });

  it('rejects bytes that are not a PKCS#12', () => {
    expect(() => inspectPkcs12(Buffer.from('not a p12'), 'x')).toThrow(Pkcs12UnreadableError);
  });

  it('rejects a .p12 whose private key matches none of its certificates', () => {
    const { privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    const asn1 = forge.pkcs12.toPkcs12Asn1(
      forge.pki.privateKeyFromPem(privateKey),
      [psc.certificate],
      'pw',
      { algorithm: '3des' },
    );
    const p12 = Buffer.from(forge.asn1.toDer(asn1).getBytes(), 'binary');

    expect(() => inspectPkcs12(p12, 'pw')).toThrow(Pkcs12ContentError);
  });

  it('rejects a .p12 without a private key', () => {
    const asn1 = forge.pkcs12.toPkcs12Asn1(null, [psc.certificate], 'pw', { algorithm: '3des' });
    const p12 = Buffer.from(forge.asn1.toDer(asn1).getBytes(), 'binary');

    expect(() => inspectPkcs12(p12, 'pw')).toThrow(Pkcs12ContentError);
  });
});
