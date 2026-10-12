import { vi } from 'vitest';

import type { PeriodSummary, SummaryClient, SummaryResult } from './summary-client';

export const SUMMARY: PeriodSummary = {
  from: '2026-09-13',
  to: '2026-10-12',
  totals: { count: 120, amountPyg: '16100000', otherCurrencyCount: 2 },
  byType: [{ type: 'FE', count: 120, amountPyg: '16100000' }],
  byStatus: [
    { status: 'approved', count: 90, amountPyg: '12000000' },
    { status: 'approved_with_observations', count: 10, amountPyg: '1100000' },
    { status: 'rejected', count: 5, amountPyg: '500000' },
  ],
  rejected: {
    count: 5,
    topCodes: [
      { code: '1321', count: 3 },
      { code: '2001', count: 2 },
    ],
  },
  pending: { count: 15, overdue: 2, dueSoon: 4, oldestDeadline: '2026-10-13T12:00:00Z' },
  previous: { count: 100 },
};

/** A tenant with no documents in the period. */
export const EMPTY: PeriodSummary = {
  from: '2026-09-13',
  to: '2026-10-12',
  totals: { count: 0, amountPyg: '0', otherCurrencyCount: 0 },
  byType: [],
  byStatus: [],
  rejected: { count: 0, topCodes: [] },
  pending: { count: 0, overdue: 0, dueSoon: 0, oldestDeadline: null },
  previous: { count: 0 },
};

export const fakeSummaryClient = (
  result: SummaryResult = { kind: 'ok', summary: SUMMARY },
): SummaryClient & { get: ReturnType<typeof vi.fn> } => ({
  get: vi.fn(() => Promise.resolve(result)),
});
