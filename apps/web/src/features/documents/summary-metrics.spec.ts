import { describe, expect, it } from 'vitest';

import { EMPTY as EMPTY_SUMMARY, SUMMARY } from './summary-fixtures';
import { approvedStats, growthPct, periodRange, rejectionRatePct } from './summary-metrics';

describe('summary metrics', () => {
  it('builds an inclusive period of N days ending today in Paraguay time', () => {
    // 2026-10-12 02:00 UTC is still 2026-10-11 in Asunción (UTC-3).
    const now = new Date('2026-10-12T02:00:00Z');
    expect(periodRange(30, now)).toEqual({ from: '2026-09-12', to: '2026-10-11' });
    expect(periodRange(7, now)).toEqual({ from: '2026-10-05', to: '2026-10-11' });
  });

  it('computes growth against the previous period and never divides by zero', () => {
    expect(growthPct(120, 100)).toBe(20);
    expect(growthPct(80, 100)).toBe(-20);
    expect(growthPct(5, 0)).toBeNull();
    expect(growthPct(0, 0)).toBeNull();
  });

  it('counts approved and approved-with-observations as approved', () => {
    expect(approvedStats(SUMMARY)).toEqual({ count: 100, pct: (100 / 120) * 100 });
  });

  it('has no approval or rejection percentage for an empty period', () => {
    expect(approvedStats(EMPTY_SUMMARY)).toEqual({ count: 0, pct: null });
    expect(rejectionRatePct(EMPTY_SUMMARY)).toBeNull();
    expect(rejectionRatePct(SUMMARY)).toBeCloseTo((5 / 120) * 100);
  });
});
