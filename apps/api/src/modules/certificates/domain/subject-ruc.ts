import { formatRuc, parseRuc, type Ruc } from '../../fiscal-config/domain/ruc.js';

/** The whole value must be the RUC: no prefix, suffix or whitespace. */
const RUC_SERIAL_NUMBER = /^RUC(\d{3,8}-\d)$/;

/**
 * The RUC a PSC certificate was issued to (§8.7): a `serialNumber`
 * attribute of exactly `RUCXXXXXXXX-X`, taken from the subject (persona
 * jurídica) or from a SubjectAltName directoryName (persona física). The
 * caller passes only those structured values, never free-form SAN text, so
 * an email or URI that merely contains a RUC cannot claim one.
 *
 * Returns `null` when no such value has a valid SET check digit, or when
 * the certificate names more than one distinct RUC.
 */
export function extractSubjectRuc(serialNumbers: readonly string[]): Ruc | null {
  const rucs = new Map<string, Ruc>();
  for (const serialNumber of serialNumbers) {
    const match = RUC_SERIAL_NUMBER.exec(serialNumber);
    if (match === null) continue;
    try {
      const ruc = parseRuc(match[1]);
      rucs.set(formatRuc(ruc), ruc);
    } catch {
      // A wrong check digit is not a RUC; the value is ignored.
    }
  }
  return rucs.size === 1 ? (rucs.values().next().value ?? null) : null;
}
