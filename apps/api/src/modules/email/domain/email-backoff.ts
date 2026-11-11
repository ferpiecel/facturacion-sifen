const MINUTE_MS = 60_000;
const DELAYS_MS = [MINUTE_MS, 5 * MINUTE_MS, 30 * MINUTE_MS, 120 * MINUTE_MS, 360 * MINUTE_MS];

/** One initial attempt plus one retry per delay; after that the email is dead. */
export const MAX_EMAIL_ATTEMPTS = DELAYS_MS.length + 1;

/** When to retry after `failedAttempts` failures (>= 1), or `null` once the attempts are used up. */
export function nextEmailAttemptAt(failedAttempts: number, now: Date): Date | null {
  return failedAttempts > DELAYS_MS.length
    ? null
    : new Date(now.getTime() + DELAYS_MS[failedAttempts - 1]);
}
