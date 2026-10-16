import { describe, expect, it } from 'vitest';
import {
  DEADLINE_WARNING_HOURS,
  TRANSMISSION_WINDOW_MS,
  hoursRemaining,
  transmissionDeadline,
} from './transmission-deadline.js';

/** Spec: HU-E6-07. SIFEN gives 72 h from signing (ADR-0008). */
describe('transmission deadline', () => {
  const signedAt = new Date('2026-10-01T12:00:00.000Z');

  it('is 72 hours after signing, with warnings at 48 and 66 hours', () => {
    expect(TRANSMISSION_WINDOW_MS).toBe(72 * 3_600_000);
    expect(transmissionDeadline(signedAt).toISOString()).toBe('2026-10-04T12:00:00.000Z');
    expect(DEADLINE_WARNING_HOURS).toEqual([48, 66]);
  });

  it('rounds the time left to a tenth of an hour and never goes negative', () => {
    const deadline = transmissionDeadline(signedAt);
    expect(hoursRemaining(deadline, new Date('2026-10-03T12:00:00.000Z'))).toBe(24);
    expect(hoursRemaining(deadline, new Date('2026-10-03T18:20:00.000Z'))).toBe(17.7);
    expect(hoursRemaining(deadline, new Date('2026-10-05T00:00:00.000Z'))).toBe(0);
  });
});
