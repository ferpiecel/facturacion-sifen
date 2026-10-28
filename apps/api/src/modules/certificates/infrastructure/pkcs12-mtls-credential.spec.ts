import { createPrivateKey, X509Certificate } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createTestAuthority, issueTestPkcs12 } from '../../../../test/support/test-pki.js';
import { pkcs12ToMtlsCredential } from './pkcs12-mtls-credential.js';

describe('pkcs12ToMtlsCredential', () => {
  const root = createTestAuthority('Test Root');
  const issued = issueTestPkcs12(root);

  it('returns the key and the leaf certificate as PEM, and the key matches the certificate', () => {
    const credential = pkcs12ToMtlsCredential(issued.p12, issued.password);
    const leaf = new X509Certificate(String(credential.cert));
    expect(leaf.checkPrivateKey(createPrivateKey(String(credential.key)))).toBe(true);
    expect(leaf.subject).toContain('Tenant S.A.');
  });

  it('puts the leaf first and appends the other certificates of the file', () => {
    const intermediate = createTestAuthority('Test Intermediate', { issuer: root });
    const withChain = issueTestPkcs12(intermediate, { bundle: [intermediate, root] }, 'pw');
    const credential = pkcs12ToMtlsCredential(withChain.p12, 'pw');
    const pems = String(credential.cert).match(
      /-----BEGIN CERTIFICATE-----[^-]+-----END CERTIFICATE-----/g,
    );
    expect(pems).toHaveLength(3);
    expect(new X509Certificate(pems?.[0] ?? '').subject).toContain('Tenant S.A.');
  });

  it('rejects a wrong password without echoing it', () => {
    let message = '';
    try {
      pkcs12ToMtlsCredential(issued.p12, 'nope-secret');
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).not.toBe('');
    expect(message).not.toContain('nope-secret');
  });
});
