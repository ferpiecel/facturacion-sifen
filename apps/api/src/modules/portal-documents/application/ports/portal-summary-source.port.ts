export interface SummaryQuery {
  /** Inclusive Asuncion calendar days, `YYYY-MM-DD`. */
  from: string;
  to: string;
  previousFrom: string;
  previousTo: string;
  /** Pending documents signed before this instant are past their 72 h window. */
  overdueBefore: Date;
  /** Pending documents signed from `overdueBefore` up to here are still on time but due within 12 h. */
  dueSoonBefore: Date;
}

/** Amounts are the stored numeric text, summed over PYG documents only. */
export interface PortalSummaryAggregates {
  totals: { count: number; amountPyg: string; otherCurrencyCount: number };
  /** One row per SIFEN `iTiDE` with documents in the period. */
  byType: { documentType: number; count: number; amountPyg: string }[];
  byStatus: { status: string; count: number; amountPyg: string }[];
  /** SIFEN codes of the period's rejected documents, most frequent first, at most 5. */
  rejectedTopCodes: { code: string; count: number }[];
  /** The tenant's current state, whatever the period. */
  pending: { count: number; overdue: number; dueSoon: number; oldestSignedAt: Date | null };
  previousCount: number;
}

/** Tenant-scoped aggregate reads inside the tenant's RLS transaction, current environment only. */
export interface PortalSummarySource {
  summarize(tenantId: string, query: SummaryQuery): Promise<PortalSummaryAggregates>;
}
