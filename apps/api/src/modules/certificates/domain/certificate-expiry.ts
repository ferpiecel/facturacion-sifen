/** HU-E3-03: the expiry alert thresholds and the preventive emission block (RNF-02). */
const DAY_MS = 86_400_000;
const MAX_DAYS = 365;
const MAX_BLOCK_DAYS = 30;

export const DEFAULT_ALERT_DAYS: readonly number[] = [60, 30, 7];
export const DEFAULT_EMISSION_BLOCK_DAYS = 1;

/**
 * `CERTIFICATE_ALERT_DAYS`: comma-separated whole days (1..365), returned unique and descending.
 * Unset or blank means the default.
 * @throws Error naming the variable (never its value) when an item is not a valid day count.
 */
export function parseAlertDays(raw: string | undefined): readonly number[] {
  if (raw === undefined || raw.trim() === '') return DEFAULT_ALERT_DAYS;
  const days = raw.split(',').map((item) => {
    const text = item.trim();
    const value = /^[0-9]+$/.test(text) ? Number(text) : Number.NaN;
    if (!Number.isInteger(value) || value < 1 || value > MAX_DAYS) {
      throw new Error(
        `CERTIFICATE_ALERT_DAYS must be whole days between 1 and ${String(MAX_DAYS)}`,
      );
    }
    return value;
  });
  return [...new Set(days)].sort((a, b) => b - a);
}

/**
 * `CERTIFICATE_EMISSION_BLOCK_DAYS`: whole days (0..30) before expiry from which emission is refused.
 * Unset or blank means one day; 0 keeps only the hard stop at expiry.
 * @throws Error naming the variable (never its value).
 */
export function parseBlockDays(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_EMISSION_BLOCK_DAYS;
  const text = raw.trim();
  const value = /^[0-9]+$/.test(text) ? Number(text) : Number.NaN;
  if (!Number.isInteger(value) || value > MAX_BLOCK_DAYS) {
    throw new Error(
      `CERTIFICATE_EMISSION_BLOCK_DAYS must be whole days between 0 and ${String(MAX_BLOCK_DAYS)}`,
    );
  }
  return value;
}

/**
 * The threshold (days) a still-valid certificate has most recently crossed, or `undefined` when it has
 * crossed none or already expired. Several crossed at once (late upload, worker outage) yield the
 * closest one only, so the tenant gets one current alert and not a burst.
 */
export function dueAlertThreshold(
  notAfter: Date,
  now: Date,
  thresholdsDays: readonly number[],
): number | undefined {
  if (now.getTime() >= notAfter.getTime()) return undefined;
  const remaining = notAfter.getTime() - now.getTime();
  const crossed = thresholdsDays.filter((days) => remaining <= days * DAY_MS);
  return crossed.length === 0 ? undefined : Math.min(...crossed);
}

/** Emission is refused from `blockDays` before expiry (inclusive) and after it. */
export function isEmissionBlocked(notAfter: Date, now: Date, blockDays: number): boolean {
  return now.getTime() >= notAfter.getTime() - blockDays * DAY_MS;
}
