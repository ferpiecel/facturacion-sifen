import { formatXmlDateTime } from './format';
import type { PeriodSummary } from './summary-client';

export const PERIOD_OPTIONS = [7, 30, 90] as const;
export type PeriodDays = (typeof PERIOD_OPTIONS)[number];

const DAY_MS = 86_400_000;
const APPROVED = new Set(['approved', 'approved_with_observations']);

const asuncionDate = (instant: Date) => formatXmlDateTime(instant.toISOString()).slice(0, 10);

/** Inclusive `YYYY-MM-DD` period of `days` days that ends today in Paraguay time. */
export function periodRange(days: number, now: Date = new Date()) {
  return {
    from: asuncionDate(new Date(now.getTime() - (days - 1) * DAY_MS)),
    to: asuncionDate(now),
  };
}

/** Percentage change against the previous period; `null` when there is nothing to compare with. */
export function growthPct(count: number, previous: number): number | null {
  return previous > 0 ? ((count - previous) / previous) * 100 : null;
}

/** Documents SIFEN approved (with or without observations) and their share of the period; `null` if empty. */
export function approvedStats({ byStatus, totals }: PeriodSummary) {
  const count = byStatus
    .filter(({ status }) => APPROVED.has(status))
    .reduce((n, s) => n + s.count, 0);
  return { count, pct: totals.count > 0 ? (count / totals.count) * 100 : null };
}

/** Share of rejected documents in the period; `null` if empty. */
export function rejectionRatePct({ rejected, totals }: PeriodSummary): number | null {
  return totals.count > 0 ? (rejected.count / totals.count) * 100 : null;
}
