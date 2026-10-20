/**
 * Paraguay local offset in hours. Paraguay adopted permanent UTC-3 in October 2024 (no DST), so a
 * fixed offset keeps the billing month independent of the tz database in use. Open product question:
 * confirm that the commercial month follows Paraguay time.
 */
export const BILLING_UTC_OFFSET_HOURS = -3;

/** First day (`YYYY-MM-01`) of the Paraguay calendar month that contains `instant`. */
export function billingPeriod(instant: Date): string {
  const local = new Date(instant.getTime() + BILLING_UTC_OFFSET_HOURS * 3_600_000);
  const month = String(local.getUTCMonth() + 1).padStart(2, '0');
  return `${String(local.getUTCFullYear())}-${month}-01`;
}
