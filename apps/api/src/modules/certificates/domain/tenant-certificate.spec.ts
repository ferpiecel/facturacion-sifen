import { X509Certificate } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  createTestAuthority,
  issueTestPkcs12,
  type LeafOptions,
  type TestAuthority,
} from '../../../../test/support/test-pki.js';
import { parseRuc } from '../../fiscal-config/domain/ruc.js';
import {
  inspectCertificate,
  validateTenantCertificate,
  type CertificatePolicy,
} from './tenant-certificate.js';

const DAY_MS = 86_400_000;
const TENANT_RUC = parseRuc('80000005-6');

let psc: TestAuthority;
let foreign: TestAuthority;

beforeAll(() => {
  psc = createTestAuthority('Test PSC Root');
  foreign = createTestAuthority('Unknown CA');
});

function inspectLeaf(issuer: TestAuthority, options: LeafOptions = {}) {
  const { leafPem } = issueTestPkcs12(issuer, { serialNumber: 'RUC80000005-6', ...options });
  return inspectCertificate(new X509Certificate(leafPem), [new X509Certificate(issuer.pem)]);
}

function policy(overrides: Partial<CertificatePolicy> = {}): CertificatePolicy {
  return {
    tenantRuc: TENANT_RUC,
    now: new Date(),
    trustedPscRoots: [new X509Certificate(psc.pem)],
    ...overrides,
  };
}

describe('inspectCertificate (HU-E3-01)', () => {
  it('exposes the subject RUC, validity window and EKUs', () => {
    const inspection = inspectLeaf(psc);

    expect(inspection.subjectRuc).toEqual(TENANT_RUC);
    expect(inspection.notBefore.getTime()).toBeLessThan(Date.now());
    expect(inspection.notAfter.getTime()).toBeGreaterThan(Date.now());
    expect(inspection.extendedKeyUsages).toContain('1.3.6.1.5.5.7.3.2');
    expect(inspection.chain).toHaveLength(1);
  });
});

describe('validateTenantCertificate (HU-E3-01, ADR-0010, §8.7)', () => {
  it('accepts a current clientAuth certificate for the tenant RUC issued by a trusted PSC', () => {
    expect(validateTenantCertificate(inspectLeaf(psc), policy())).toEqual([]);
  });

  it('accepts the RUC carried in the SubjectAlternativeName', () => {
    const inspection = inspectLeaf(psc, {
      serialNumber: 'CI1234567',
      sanSerialNumber: 'RUC80000005-6',
    });
    expect(validateTenantCertificate(inspection, policy())).toEqual([]);
  });

  it('rejects a certificate issued to another RUC', () => {
    const inspection = inspectLeaf(psc, { serialNumber: 'RUC4490207-7' });
    expect(validateTenantCertificate(inspection, policy())).toEqual([
      { code: 'ruc-mismatch', expected: '80000005-6', actual: '4490207-7' },
    ]);
  });

  it('rejects a certificate without a readable RUC', () => {
    const inspection = inspectLeaf(psc, { serialNumber: 'CI1234567' });
    expect(validateTenantCertificate(inspection, policy())).toEqual([
      { code: 'ruc-mismatch', expected: '80000005-6', actual: null },
    ]);
  });

  it('rejects a certificate without the clientAuth EKU', () => {
    const inspection = inspectLeaf(psc, { clientAuth: false });
    expect(validateTenantCertificate(inspection, policy())).toEqual([
      { code: 'missing-client-auth' },
    ]);
  });

  it('rejects a certificate without any extended key usage', () => {
    const inspection = inspectLeaf(psc, { omitExtendedKeyUsage: true });
    expect(inspection.extendedKeyUsages).toEqual([]);
    expect(validateTenantCertificate(inspection, policy())).toEqual([
      { code: 'missing-client-auth' },
    ]);
  });

  it('rejects an expired certificate', () => {
    const notAfter = new Date(Date.now() - DAY_MS);
    const inspection = inspectLeaf(psc, {
      notBefore: new Date(Date.now() - 10 * DAY_MS),
      notAfter,
    });
    expect(validateTenantCertificate(inspection, policy())).toEqual([
      { code: 'expired', notAfter: inspection.notAfter },
    ]);
  });

  it('rejects a certificate that is not valid yet', () => {
    const inspection = inspectLeaf(psc, {
      notBefore: new Date(Date.now() + DAY_MS),
      notAfter: new Date(Date.now() + 10 * DAY_MS),
    });
    expect(validateTenantCertificate(inspection, policy())).toEqual([
      { code: 'not-yet-valid', notBefore: inspection.notBefore },
    ]);
  });

  it('rejects a certificate that does not chain to a configured PSC root', () => {
    expect(validateTenantCertificate(inspectLeaf(foreign), policy())).toEqual([
      { code: 'untrusted-chain' },
    ]);
  });

  it('accepts a certificate issued by a PSC intermediate bundled in the .p12', () => {
    const intermediate = createTestAuthority('Test PSC Issuing CA', psc);
    expect(validateTenantCertificate(inspectLeaf(intermediate), policy())).toEqual([]);
  });

  it('rejects a PSC intermediate chain when the intermediate is not bundled', () => {
    const intermediate = createTestAuthority('Test PSC Issuing CA', psc);
    const { leafPem } = issueTestPkcs12(intermediate, { serialNumber: 'RUC80000005-6' });
    const inspection = inspectCertificate(new X509Certificate(leafPem), []);
    expect(validateTenantCertificate(inspection, policy())).toEqual([{ code: 'untrusted-chain' }]);
  });

  it('rejects a CA certificate presented as the tenant certificate', () => {
    const inspection = inspectCertificate(new X509Certificate(psc.pem), []);
    expect(validateTenantCertificate(inspection, policy()).map(({ code }) => code)).toContain(
      'untrusted-chain',
    );
  });

  it('rejects every certificate when no PSC root is configured', () => {
    expect(validateTenantCertificate(inspectLeaf(psc), policy({ trustedPscRoots: [] }))).toEqual([
      { code: 'untrusted-chain' },
    ]);
  });

  it('does not trust a bundled root that impersonates the PSC by name', () => {
    const impostor = createTestAuthority('Test PSC Root');
    expect(validateTenantCertificate(inspectLeaf(impostor), policy())).toEqual([
      { code: 'untrusted-chain' },
    ]);
  });

  it('reports every rejection at once', () => {
    const inspection = inspectLeaf(foreign, {
      serialNumber: 'RUC4490207-7',
      clientAuth: false,
      notBefore: new Date(Date.now() - 10 * DAY_MS),
      notAfter: new Date(Date.now() - DAY_MS),
    });
    expect(validateTenantCertificate(inspection, policy()).map(({ code }) => code)).toEqual([
      'ruc-mismatch',
      'missing-client-auth',
      'expired',
      'untrusted-chain',
    ]);
  });
});
