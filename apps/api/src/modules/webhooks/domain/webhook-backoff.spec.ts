import { describe, expect, it } from 'vitest';
import { RETRY_WINDOW_MS, nextRetryAt } from './webhook-backoff.js';

const first = new Date('2026-09-22T00:00:00.000Z');
const at = (ms: number) => new Date(first.getTime() + ms);
const MIN = 60_000;
const HOUR = 60 * MIN;

/** random = 1 -> no jitter reduction (the nominal delay). */
const delay = (failed: number, now = first, random = () => 1) => {
  const next = nextRetryAt({ firstAttemptAt: first, now, failedAttempts: failed, random });
  return next === null ? null : next.getTime() - now.getTime();
};

describe('webhook retry backoff (HU-E11-01)', () => {
  it('retries for 24 hours', () => {
    expect(RETRY_WINDOW_MS).toBe(24 * HOUR);
  });

  it('doubles from one minute and caps at four hours', () => {
    expect([1, 2, 3, 4, 5, 9, 10, 20].map((n) => delay(n))).toEqual([
      MIN,
      2 * MIN,
      4 * MIN,
      8 * MIN,
      16 * MIN,
      4 * HOUR,
      4 * HOUR,
      4 * HOUR,
    ]);
  });

  it('applies equal jitter: between half and the whole nominal delay', () => {
    expect(delay(3, first, () => 0)).toBe(2 * MIN);
    expect(delay(3, first, () => 0.5)).toBe(3 * MIN);
  });

  it('never schedules past the 24 h deadline: the last attempt lands on it', () => {
    const now = at(RETRY_WINDOW_MS - MIN);
    expect(
      nextRetryAt({ firstAttemptAt: first, now, failedAttempts: 20, random: () => 1 }),
    ).toEqual(at(RETRY_WINDOW_MS));
  });

  it('dead-letters once the deadline has been reached', () => {
    expect(delay(20, at(RETRY_WINDOW_MS))).toBeNull();
    expect(delay(20, at(RETRY_WINDOW_MS + MIN))).toBeNull();
  });

  it('rejects a non-positive attempt count', () => {
    expect(() => delay(0)).toThrow(RangeError);
  });
});
