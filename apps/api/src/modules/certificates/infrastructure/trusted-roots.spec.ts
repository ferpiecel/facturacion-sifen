import { beforeAll, describe, expect, it } from 'vitest';
import {
  createTestAuthority,
  issueTestPkcs12,
  type TestAuthority,
} from '../../../../test/support/test-pki.js';
import { loadTrustedRoots, parseTrustedRoots, TrustedRootsError } from './trusted-roots.js';

let one: TestAuthority;
let two: TestAuthority;
beforeAll(() => {
  one = createTestAuthority('Test PSC Root 1');
  two = createTestAuthority('Test PSC Root 2');
});

describe('parseTrustedRoots (HU-E3-01)', () => {
  it('parses every certificate of a PEM bundle', () => {
    const roots = parseTrustedRoots(`${one.pem}\n${two.pem}`);
    expect(roots.map((r) => r.subject)).toEqual(['CN=Test PSC Root 1', 'CN=Test PSC Root 2']);
  });

  it('refuses an empty bundle and text without certificates', () => {
    expect(() => parseTrustedRoots('')).toThrow(TrustedRootsError);
    expect(() => parseTrustedRoots('not a certificate')).toThrow(TrustedRootsError);
  });

  it('refuses a bundle with a corrupt certificate instead of skipping it', () => {
    const corrupt = '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----';
    expect(() => parseTrustedRoots(`${one.pem}\n${corrupt}`)).toThrow(TrustedRootsError);
  });
});

describe('parseTrustedRoots CA requirement (HU-E3-01)', () => {
  it('refuses a bundle that contains a non-CA certificate', () => {
    const leaf = issueTestPkcs12(one, { serialNumber: 'RUC80000005-6' }).leafPem;
    expect(() => parseTrustedRoots(`${one.pem}\n${leaf}`)).toThrow(/not a CA/);
    const notCa = createTestAuthority('Not A CA', { ca: false });
    expect(() => parseTrustedRoots(notCa.pem)).toThrow(/not a CA/);
  });
});

describe('loadTrustedRoots (HU-E3-01)', () => {
  it('reads the file named by PSC_TRUSTED_ROOTS_PATH', () => {
    const roots = loadTrustedRoots({ PSC_TRUSTED_ROOTS_PATH: '/etc/sifen/psc.pem' }, (path) => {
      expect(path).toBe('/etc/sifen/psc.pem');
      return one.pem;
    });
    expect(roots).toHaveLength(1);
  });

  it('fails closed when the path is not configured or the file cannot be read', () => {
    expect(() => loadTrustedRoots({}, () => one.pem)).toThrow(/PSC_TRUSTED_ROOTS_PATH/);
    expect(() =>
      loadTrustedRoots({ PSC_TRUSTED_ROOTS_PATH: '/missing.pem' }, () => {
        throw new Error('ENOENT: secret detail');
      }),
    ).toThrow(TrustedRootsError);
  });

  it('does not leak the underlying read error', () => {
    expect(() =>
      loadTrustedRoots({ PSC_TRUSTED_ROOTS_PATH: '/missing.pem' }, () => {
        throw new Error('ENOENT: secret detail');
      }),
    ).not.toThrow(/secret detail/);
  });
});
