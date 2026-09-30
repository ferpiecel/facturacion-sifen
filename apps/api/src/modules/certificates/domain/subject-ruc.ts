import { formatRuc, parseRuc, type Ruc } from '../../fiscal-config/domain/ruc.js';

const SUBJECT_SERIAL_NUMBER = /^serialNumber=RUC(\d{3,8}-\d)$/;
const SAN_RUC = /(?<![A-Za-z0-9])RUC(\d{3,8}-\d)(?!\d)/g;

/**
 * The RUC a PSC certificate was issued to (§8.7): `RUCXXXXXXXX-X` in the
 * subject `serialNumber` (persona jurídica) or in the SubjectAlternativeName
 * (persona física). Takes Node's `X509Certificate.subject` (one `key=value`
 * per line) and `subjectAltName` strings.
 *
 * Returns `null` when no well-formed RUC with a valid SET check digit is
 * present, or when the certificate names more than one distinct RUC.
 */
export function extractSubjectRuc(subject: string, subjectAltName: string | undefined): Ruc | null {
  const candidates = subject
    .split('\n')
    .map((line) => SUBJECT_SERIAL_NUMBER.exec(line)?.[1])
    .filter((value) => value !== undefined);
  for (const match of (subjectAltName ?? '').matchAll(SAN_RUC)) {
    candidates.push(match[1]);
  }

  const rucs = new Map<string, Ruc>();
  for (const candidate of candidates) {
    try {
      const ruc = parseRuc(candidate);
      rucs.set(formatRuc(ruc), ruc);
    } catch {
      // A wrong check digit is not a RUC; the candidate is ignored.
    }
  }
  return rucs.size === 1 ? (rucs.values().next().value ?? null) : null;
}
