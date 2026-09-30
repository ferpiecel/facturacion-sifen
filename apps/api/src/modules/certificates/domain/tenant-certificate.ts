import type { X509Certificate } from 'node:crypto';
import { formatRuc, type Ruc } from '../../fiscal-config/domain/ruc.js';
import { extractSubjectRuc } from './subject-ruc.js';
import { readX509Profile } from './x509-profile.js';

/**
 * EKU `id-kp-clientAuth` (RFC 5280 §4.2.1.12). Required, strictly, for SIFEN
 * mTLS: backlog HU-E3-01 rejects a certificate without it and §8.7 lists it.
 */
export const CLIENT_AUTH_EKU = '1.3.6.1.5.5.7.3.2';

/** Most intermediate CA certificates accepted between a tenant certificate and a PSC root. */
const MAX_INTERMEDIATES = 4;

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

export type Pkcs12ContentReason =
  | 'too-large'
  | 'excessive-iterations'
  | 'excessive-key-derivations'
  | 'too-many-certificates'
  | 'key-count'
  | 'unsupported-key-algorithm'
  | 'no-matching-certificate';

/**
 * The PKCS#12 was refused for its shape or cost rather than its password:
 * too large, too expensive to open, or not exactly one RSA key with its
 * certificate. Carries no bytes of the file.
 */
export class Pkcs12ContentError extends Error {
  constructor(
    readonly reason: Pkcs12ContentReason,
    message: string,
  ) {
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
  /** keyUsage digitalSignature bit; `false` when the extension is absent. */
  readonly digitalSignature: boolean;
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
  | { readonly code: 'missing-digital-signature' }
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
  const profile = readX509Profile(certificate.raw);
  return {
    subjectRuc: extractSubjectRuc([...profile.subjectSerialNumbers, ...profile.sanSerialNumbers]),
    notBefore: certificate.validFromDate,
    notAfter: certificate.validToDate,
    extendedKeyUsages: Array.isArray(extendedKeyUsages)
      ? extendedKeyUsages.filter((usage: unknown): usage is string => typeof usage === 'string')
      : [],
    digitalSignature: profile.digitalSignature,
    certificate,
    chain,
  };
}

/**
 * HU-E3-01 / ADR-0010 / §8.7: a tenant may only load a certificate issued to
 * its own RUC, with the `clientAuth` EKU and the digitalSignature key usage
 * (XMLDSig signing of the DE; neither §8.7 nor ADR-0010 requires
 * nonRepudiation, so it is not checked), currently valid, and chaining to a
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
  if (!inspection.digitalSignature) {
    rejections.push({ code: 'missing-digital-signature' });
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

interface CaCandidate {
  readonly certificate: X509Certificate;
  /** basicConstraints pathLenConstraint; `null` when unconstrained. */
  readonly pathLength: number | null;
}

/**
 * Searches for an issuer path from the tenant certificate, through currently
 * valid CA certificates bundled in the `.p12`, to a configured PSC root,
 * backtracking over every candidate issuer. Trust comes only from the roots'
 * public keys (a certificate that merely copies a root's name does not
 * verify), and every CA's pathLenConstraint bounds the intermediates below it.
 */
function chainsToTrustedRoot(
  inspection: CertificateInspection,
  policy: CertificatePolicy,
): boolean {
  if (inspection.certificate.ca) {
    return false;
  }
  const roots = caCandidates(policy.trustedPscRoots, policy.now);
  const intermediates = caCandidates(inspection.chain, policy.now);
  const verified = new Map<string, boolean>();
  const issues = (subject: X509Certificate, issuer: X509Certificate): boolean => {
    const key = `${subject.fingerprint256}>${issuer.fingerprint256}`;
    let result = verified.get(key);
    if (result === undefined) {
      result = subject.checkIssued(issuer) && subject.verify(issuer.publicKey);
      verified.set(key, result);
    }
    return result;
  };
  const allows = (ca: CaCandidate, below: number) =>
    ca.pathLength === null || below <= ca.pathLength;

  const search = (current: X509Certificate, below: number, path: readonly string[]): boolean =>
    roots.some((root) => allows(root, below) && issues(current, root.certificate)) ||
    (below < MAX_INTERMEDIATES &&
      intermediates.some(
        (ca) =>
          !path.includes(ca.certificate.fingerprint256) &&
          allows(ca, below) &&
          issues(current, ca.certificate) &&
          search(ca.certificate, below + 1, [...path, ca.certificate.fingerprint256]),
      ));

  return search(inspection.certificate, 0, [inspection.certificate.fingerprint256]);
}

/** Current CA certificates with their path length; unreadable ones are skipped. */
function caCandidates(certificates: readonly X509Certificate[], now: Date): CaCandidate[] {
  return certificates.flatMap((certificate) => {
    if (!certificate.ca || !isCurrent(certificate, now)) return [];
    try {
      return [{ certificate, pathLength: readX509Profile(certificate.raw).pathLength }];
    } catch {
      return [];
    }
  });
}

function isCurrent(certificate: X509Certificate, now: Date): boolean {
  return certificate.validFromDate <= now && now <= certificate.validToDate;
}
