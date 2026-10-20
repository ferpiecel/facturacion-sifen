import { describe, expect, it } from 'vitest';
import { billingPeriod } from './billing-period.js';

/** Spec: HU-E15-02. The billing month follows Paraguay local time (UTC-3, no DST since 2024-10). */
describe('billingPeriod', () => {
  it('maps an instant to the first day of its Paraguay month', () => {
    expect(billingPeriod(new Date('2026-10-15T12:00:00Z'))).toBe('2026-10-01');
  });

  it('keeps the last Paraguay hours of a month in that month', () => {
    expect(billingPeriod(new Date('2026-11-01T02:59:59Z'))).toBe('2026-10-01');
  });

  it('starts the next month at 03:00 UTC', () => {
    expect(billingPeriod(new Date('2026-11-01T03:00:00Z'))).toBe('2026-11-01');
  });

  it('rolls over the year', () => {
    expect(billingPeriod(new Date('2027-01-01T02:00:00Z'))).toBe('2026-12-01');
    expect(billingPeriod(new Date('2027-01-01T03:00:00Z'))).toBe('2027-01-01');
  });
});
