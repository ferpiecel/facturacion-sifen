import { addAmounts } from '../domain/summary-amounts.js';
import { portalDocumentType, type PortalDocumentType } from '../domain/document-type.js';
import { trimDecimals } from '../domain/portal-document.js';
import { asuncionToday, resolveSummaryPeriod } from '../domain/summary-period.js';
import { TRANSMISSION_WINDOW_MS } from '../../transmission/domain/transmission-deadline.js';
import type { PortalSummarySource } from './ports/portal-summary-source.port.js';

/** A pending document is "due soon" when its deadline is within this time. */
export const DUE_SOON_MS = 12 * 3_600_000;

export interface PortalSummary {
  from: string;
  to: string;
  totals: { count: number; amountPyg: string; otherCurrencyCount: number };
  byType: { type: PortalDocumentType | null; count: number; amountPyg: string }[];
  byStatus: { status: string; count: number; amountPyg: string }[];
  rejected: { count: number; topCodes: { code: string; count: number }[] };
  pending: { count: number; overdue: number; dueSoon: number; oldestDeadline: string | null };
  previous: { count: number };
}

function byCountDesc<T extends { count: number }>(a: T, b: T): number {
  return b.count - a.count;
}

/**
 * HU-E12-03: the active tenant's period summary. Amounts are reported as stored (NCE included, positive).
 * @throws InvalidSummaryQueryError for a bad or too long period.
 */
export function createGetPortalSummary(deps: { source: PortalSummarySource; now: () => Date }) {
  return async (tenantId: string, rawQuery: Record<string, unknown>): Promise<PortalSummary> => {
    const now = deps.now();
    const period = resolveSummaryPeriod(rawQuery, asuncionToday(now));
    const data = await deps.source.summarize(tenantId, {
      ...period,
      overdueBefore: new Date(now.getTime() - TRANSMISSION_WINDOW_MS),
      dueSoonBefore: new Date(now.getTime() - TRANSMISSION_WINDOW_MS + DUE_SOON_MS),
    });

    const types = new Map<PortalDocumentType | null, { count: number; amount: string }>();
    for (const row of data.byType) {
      const type = portalDocumentType(row.documentType);
      const seen = types.get(type) ?? { count: 0, amount: '0' };
      types.set(type, {
        count: seen.count + row.count,
        amount: addAmounts(seen.amount, row.amountPyg),
      });
    }
    const byType = [...types].map(([type, v]) => ({
      type,
      count: v.count,
      amountPyg: trimDecimals(v.amount),
    }));
    byType.sort((a, b) => byCountDesc(a, b) || (a.type ?? '~').localeCompare(b.type ?? '~'));

    const byStatus = data.byStatus
      .map((row) => ({ ...row, amountPyg: trimDecimals(row.amountPyg) }))
      .sort((a, b) => byCountDesc(a, b) || a.status.localeCompare(b.status));

    return {
      from: period.from,
      to: period.to,
      totals: { ...data.totals, amountPyg: trimDecimals(data.totals.amountPyg) },
      byType,
      byStatus,
      rejected: {
        count: data.byStatus.find((row) => row.status === 'rejected')?.count ?? 0,
        topCodes: data.rejectedTopCodes,
      },
      pending: {
        count: data.pending.count,
        overdue: data.pending.overdue,
        dueSoon: data.pending.dueSoon,
        oldestDeadline: data.pending.oldestSignedAt
          ? new Date(data.pending.oldestSignedAt.getTime() + TRANSMISSION_WINDOW_MS).toISOString()
          : null,
      },
      previous: { count: data.previousCount },
    };
  };
}
