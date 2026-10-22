import { describe, expect, it } from 'vitest';
import { MAX_EMAIL_ATTEMPTS, nextEmailAttemptAt } from './email-backoff.js';

const NOW = new Date('2026-10-21T12:00:00Z');

describe('nextEmailAttemptAt', () => {
  it('backs off from one minute up to six hours', () => {
    expect(nextEmailAttemptAt(1, NOW)).toEqual(new Date(NOW.getTime() + 60_000));
    expect(nextEmailAttemptAt(2, NOW)).toEqual(new Date(NOW.getTime() + 5 * 60_000));
    expect(nextEmailAttemptAt(5, NOW)).toEqual(new Date(NOW.getTime() + 360 * 60_000));
  });

  it('gives up once the attempts are used up', () => {
    expect(MAX_EMAIL_ATTEMPTS).toBe(6);
    expect(nextEmailAttemptAt(MAX_EMAIL_ATTEMPTS, NOW)).toBeNull();
  });
});
