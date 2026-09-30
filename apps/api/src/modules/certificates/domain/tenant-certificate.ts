import type { X509Certificate } from 'node:crypto';
import { formatRuc, type Ruc } from '../../fiscal-config/domain/ruc.js';
import { extractSubjectRuc } from './subject-ruc.js';

/** EKU `id-kp-clientAuth` (RFC 5280 §4.2.1.12), required for SIFEN mTLS (§8.7). */
export const CLIENT_AUTH_EKU = '1.3.6.1.5.5.7.3.2';

/** Longest issuer path accepted between a tenant certificate and a PSC root. */
const MAX_CHAIN_DEPTH = 5;

/**
 * The PKCS#12 could not be opened: wrong password or malformed bytes.
 * Deliberately carries no detail and no cause, so neither the password nor
 * the parser's diagnostics can reach a log or a response.
 */
export class Pkcs12UnreadableError extends Error {
  constructor() {
    super('PKCS#12 could not be opened (wrong password or malformed file)');
    this.name = 'Pkcs12UnreadableError';
  }
}

/** The PKCS#12 opened but does not hold exactly one key and its certificate. */
export class Pkcs12ContentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Pkcs12ContentError';
  }
}

/** Public facts about a tenant certificate; never holds the private key. */
export interface CertificateInspection {
  /** RUC from the subject serialNumber or SAN, or `null` when absent or ambiguous. */
  readonly subjectRuc: Ruc | null;
  readonly notBefore: Date;
  readonly notAfter: Date;
  /** Extended key usage OIDs; empty when the extension is absent. */
  readonly extendedKeyUsages: readonly string[];
  readonly certificate: X509Certificate;
  /** The other certificates bundled with it (candidate intermediates). */
  readonly chain: readonly X509Certificate[];
}

export interface CertificatePolicy {
  readonly tenantRuc: Ruc;
  readonly now: Date;
  /** PSC root certificates enabled by the MIC; configuration, never hardcoded. */
  readonly trustedPscRoots: readonly X509Certificate[];
}

export type CertificateRejection =
  | { readonly code: 'ruc-mismatch'; readonly expected: string; readonly actual: string | null }
  | { readonly code: 'missing-client-auth' }
  | { readonly code: 'expired'; readonly notAfter: Date }
  | { readonly code: 'not-yet-valid'; readonly notBefore: Date }
  | { readonly code: 'untrusted-chain' };

export function inspectCertificate(
  certificate: X509Certificate,
  chain: readonly X509Certificate[],
): CertificateInspection {
  // Node exposes the EKU OIDs as `keyUsage`, undefined (despite its typing)
  // when the extension is absent.
  const extendedKeyUsages: unknown = certificate.keyUsage;
  return {
    subjectRuc: extractSubjectRuc(certificate.subject, certificate.subjectAltName),
    notBefore: certificate.validFromDate,
    notAfter: certificate.validToDate,
    extendedKeyUsages: Array.isArray(extendedKeyUsages)
      ? extendedKeyUsages.filter((usage: unknown): usage is string => typeof usage === 'string')
      : [],
    certificate,
    chain,
  };
}

/**
 * HU-E3-01 / ADR-0010 / §8.7: a tenant may only load a certificate issued to
 * its own RUC, with the `clientAuth` EKU, currently valid, and chaining to a
 * configured PSC root. Returns every rejection; an empty list means valid.
 */
export function validateTenantCertificate(
  inspection: CertificateInspection,
  policy: CertificatePolicy,
): readonly CertificateRejection[] {
  const rejections: CertificateRejection[] = [];
  const expected = formatRuc(policy.tenantRuc);
  const actual = inspection.subjectRuc === null ? null : formatRuc(inspection.subjectRuc);
  if (actual !== expected) {
    rejections.push({ code: 'ruc-mismatch', expected, actual });
  }
  if (!inspection.extendedKeyUsages.includes(CLIENT_AUTH_EKU)) {
    rejections.push({ code: 'missing-client-auth' });
  }
  if (policy.now.getTime() > inspection.notAfter.getTime()) {
    rejections.push({ code: 'expired', notAfter: inspection.notAfter });
  } else if (policy.now.getTime() < inspection.notBefore.getTime()) {
    rejections.push({ code: 'not-yet-valid', notBefore: inspection.notBefore });
  }
  if (!chainsToTrustedRoot(inspection, policy)) {
    rejections.push({ code: 'untrusted-chain' });
  }
  return rejections;
}

/**
 * Walks issuer links from the tenant certificate, through currently valid CA
 * certificates bundled in the `.p12`, until one is signed by a configured PSC
 * root. Trust comes only from the roots' public keys: a bundled certificate
 * that merely copies a root's name does not verify.
 */
function chainsToTrustedRoot(
  inspection: CertificateInspection,
  policy: CertificatePolicy,
): boolean {
  if (inspection.certificate.ca) {
    return false;
  }
  const roots = policy.trustedPscRoots.filter((root) => root.ca && isCurrent(root, policy.now));
  const intermediates = inspection.chain.filter((cert) => cert.ca && isCurrent(cert, policy.now));
  let current = inspection.certificate;
  for (let depth = 0; depth < MAX_CHAIN_DEPTH; depth += 1) {
    if (roots.some((root) => isIssuedBy(current, root))) {
      return true;
    }
    const issuer = intermediates.find(
      (cert) => cert.fingerprint256 !== current.fingerprint256 && isIssuedBy(current, cert),
    );
    if (issuer === undefined) {
      return false;
    }
    current = issuer;
  }
  return false;
}

function isIssuedBy(subject: X509Certificate, issuer: X509Certificate): boolean {
  return subject.checkIssued(issuer) && subject.verify(issuer.publicKey);
}

function isCurrent(certificate: X509Certificate, now: Date): boolean {
  return certificate.validFromDate <= now && now <= certificate.validToDate;
}
