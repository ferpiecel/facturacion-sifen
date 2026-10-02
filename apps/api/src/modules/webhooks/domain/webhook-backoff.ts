const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/** Deliveries are retried for 24 hours from the first attempt, then dead-lettered. */
export const RETRY_WINDOW_MS = 24 * HOUR_MS;
const BASE_DELAY_MS = MINUTE_MS;
const MAX_DELAY_MS = 4 * HOUR_MS;

export interface NextRetryInput {
  readonly firstAttemptAt: Date;
  readonly now: Date;
  /** Attempts that have failed so far (>= 1). */
  readonly failedAttempts: number;
  /** Uniform [0, 1); injected so schedules are deterministic in tests. */
  readonly random: () => number;
}

/**
 * When to retry a failed delivery: exponential from 1 minute, capped at 4 hours, with equal
 * jitter (between half and the whole nominal delay). The last attempt is clamped to the
 * 24 h deadline; once that has been reached the result is `null` and the delivery is dead.
 *
 * @throws RangeError when `failedAttempts` is not a positive integer, `random()` leaves [0, 1)
 * or a date is invalid.
 */
export function nextRetryAt(input: NextRetryInput): Date | null {
  const { failedAttempts, now } = input;
  if (!Number.isInteger(failedAttempts) || failedAttempts < 1) {
    throw new RangeError('failedAttempts must be a positive integer');
  }
  const random = input.random();
  if (!Number.isFinite(random) || random < 0 || random >= 1) {
    throw new RangeError('random() must return a number in [0, 1)');
  }
  if (!Number.isFinite(input.firstAttemptAt.getTime()) || !Number.isFinite(now.getTime())) {
    throw new RangeError('firstAttemptAt and now must be valid dates');
  }
  const deadline = input.firstAttemptAt.getTime() + RETRY_WINDOW_MS;
  if (now.getTime() >= deadline) {
    return null;
  }
  const nominal = Math.min(BASE_DELAY_MS * 2 ** Math.min(failedAttempts - 1, 20), MAX_DELAY_MS);
  const delay = Math.round(nominal / 2 + (nominal / 2) * random);
  return new Date(Math.min(now.getTime() + delay, deadline));
}
