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

const DEFAULT_ITERATIONS = forge.asn1.integerToDer(2048).getBytes();

/**
 * Re-encodes a `.p12`, letting `visit` edit any ASN.1 node, including those
 * nested in OCTET STRINGs that hold DER (authSafe, plaintext SafeContents).
 * Lengths are recomputed, so edits need not preserve sizes.
 */
function rewritePkcs12(p12: Buffer, visit: (node: forge.asn1.Asn1) => void): Buffer {
  const walk = (node: forge.asn1.Asn1): void => {
    visit(node);
    if (Array.isArray(node.value)) {
      node.value.forEach(walk);
    } else if (
      node.tagClass === forge.asn1.Class.UNIVERSAL &&
      node.type === forge.asn1.Type.OCTETSTRING &&
      node.value.startsWith('0') &&
      node.value.length > 32
    ) {
      const inner = forge.asn1.fromDer(node.value);
      walk(inner);
      node.value = forge.asn1.toDer(inner).getBytes();
    }
  };
  const root = forge.asn1.fromDer(p12.toString('binary'));
  walk(root);
  return Buffer.from(forge.asn1.toDer(root).getBytes(), 'binary');
}

/** Replaces every default (2048) PBE/PBKDF2/MAC iteration count with `count`. */
function withIterations(p12: Buffer, count: number): Buffer {
  return rewritePkcs12(p12, (node) => {
    if (node.type === forge.asn1.Type.INTEGER && node.value === DEFAULT_ITERATIONS) {
      node.value = forge.asn1.integerToDer(count).getBytes();
    }
  });
}

/** Repeats the shrouded key bag `copies` times, so opening needs that many key decryptions. */
function withKeyBagCopies(p12: Buffer, copies: number): Buffer {
  return rewritePkcs12(p12, (node) => {
    if (!Array.isArray(node.value)) return;
    const first = node.value.at(0);
    const bagId = Array.isArray(first?.value) ? first.value.at(0) : undefined;
    if (
      first !== undefined &&
      bagId?.type === forge.asn1.Type.OID &&
      forge.asn1.derToOid(bagId.value as string) === forge.pki.oids.pkcs8ShroudedKeyBag
    ) {
      node.value = Array.from({ length: copies }, () => first);
    }
  });
}

function rejectionReason(attempt: () => unknown): string | undefined {
  try {
    attempt();
  } catch (error) {
    return error instanceof Pkcs12ContentError ? error.reason : (error as Error).name;
  }
  return undefined;
}

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

  it('rejects a file larger than 64 KiB before parsing it', () => {
    expect(rejectionReason(() => inspectPkcs12(Buffer.alloc(64 * 1024 + 1), 'x'))).toBe(
      'too-large',
    );
  });

  it.each([
    ['the MAC', {}],
    ['PKCS#12 PBE (3DES)', { useMac: false }],
    ['PBES2/PBKDF2 (AES-256)', { useMac: false, algorithm: 'aes256' as const }],
  ])('rejects an excessive iteration count in %s before deriving keys', (_case, pkcs12) => {
    const { p12, password } = issueTestPkcs12(psc, { serialNumber: 'RUC80000005-6', pkcs12 });
    const hostile = withIterations(p12, 500_000);

    const started = Date.now();
    expect(rejectionReason(() => inspectPkcs12(hostile, password))).toBe('excessive-iterations');
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('caps the number of key derivations, however cheap each one is', () => {
    const { p12, password } = issueTestPkcs12(psc, {
      serialNumber: 'RUC80000005-6',
      pkcs12: { useMac: false },
    });
    expect(rejectionReason(() => inspectPkcs12(withKeyBagCopies(p12, 40), password))).toBe(
      'excessive-key-derivations',
    );
  });

  it('caps the total iterations across key derivations, each below the per-call limit', () => {
    const { p12, password } = issueTestPkcs12(psc, {
      serialNumber: 'RUC80000005-6',
      pkcs12: { useMac: false, count: 90_000 },
    });
    // 3 valid key bags x (key + IV) x 90000 = 540000 iterations, over the total budget.
    const hostile = withKeyBagCopies(p12, 3);
    expect(rejectionReason(() => inspectPkcs12(hostile, password))).toBe(
      'excessive-key-derivations',
    );
  });

  it('restores the forge key-derivation functions after a rejection', () => {
    const pbe = (forge.pki as unknown as { pbe: Record<string, unknown> }).pbe;
    const before = [forge.pkcs12, pbe, forge.pkcs5].map((owner) => ({ ...owner }));
    const { p12, password } = issueTestPkcs12(psc, { serialNumber: 'RUC80000005-6' });

    expect(rejectionReason(() => inspectPkcs12(withIterations(p12, 500_000), password))).toBe(
      'excessive-iterations',
    );
    expect([forge.pkcs12, pbe, forge.pkcs5].map((owner) => ({ ...owner }))).toEqual(before);
  });

  it('rejects a .p12 bundling more than 10 certificates, bounding chain building', () => {
    const { p12, password } = issueTestPkcs12(psc, {
      serialNumber: 'RUC80000005-6',
      bundle: Array.from({ length: 10 }, () => psc),
    });
    expect(rejectionReason(() => inspectPkcs12(p12, password))).toBe('too-many-certificates');
  });

  it('reports a leaf with malformed DER extensions as unreadable, not as an unclassified error', () => {
    const { asn1 } = forge;
    const keyUsageValue = asn1.create(
      asn1.Class.UNIVERSAL,
      asn1.Type.OCTETSTRING,
      false,
      '\x07\x80',
    );
    const { p12, password } = issueTestPkcs12(psc, {
      serialNumber: 'RUC80000005-6',
      keyUsageValue,
    });

    expect(() => inspectPkcs12(p12, password)).toThrow(Pkcs12UnreadableError);
  });

  it('reports a non-RSA private key as unsupported instead of a wrong password', () => {
    const { p12, password } = issueTestPkcs12(psc, {
      serialNumber: 'RUC80000005-6',
      pkcs12: { useMac: false },
    });
    const { privateKey } = generateKeyPairSync('ec', {
      namedCurve: 'prime256v1',
      privateKeyEncoding: { type: 'pkcs8', format: 'der' },
      publicKeyEncoding: { type: 'spki', format: 'der' },
    });
    const ecKey = forge.pki.encryptPrivateKeyInfo(
      forge.asn1.fromDer(privateKey.toString('binary')),
      password,
      { algorithm: '3des' },
    );
    const withEcKey = rewritePkcs12(p12, (node) => {
      const children = Array.isArray(node.value) ? node.value : [];
      const bagId = children.at(0);
      const bagValue = children.at(1);
      if (
        bagId?.type === forge.asn1.Type.OID &&
        forge.asn1.derToOid(bagId.value as string) === forge.pki.oids.pkcs8ShroudedKeyBag &&
        Array.isArray(bagValue?.value)
      ) {
        bagValue.value = [ecKey];
      }
    });

    expect(rejectionReason(() => inspectPkcs12(withEcKey, password))).toBe(
      'unsupported-key-algorithm',
    );
  });
});
