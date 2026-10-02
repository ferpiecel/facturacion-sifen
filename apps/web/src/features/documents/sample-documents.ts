// Mock data for the documents explorer until `GET /v1/documents` exists (the
// screen shows "Datos de ejemplo"). Shapes mirror the domain so the fixture can
// be swapped for the API response.

export interface PeriodSummary {
  period: string;
  issued: number;
  issuedGrowthPct: number;
  goal: number;
  approved: number;
  approvedPct: number;
  queued: number;
  queueAvgLatencySeconds: number;
  rejected: number;
  errorRatePct: number;
  /** SIFEN codes behind the rejected documents (verified rules only). */
  rejectionCodes: readonly string[];
}

// 1.398 approved + 24 queued + 6 rejected = 1.428 issued.
export const SAMPLE_PERIOD_SUMMARY: PeriodSummary = {
  period: 'Últimos 30 días',
  issued: 1428,
  issuedGrowthPct: 14.2,
  goal: 2000,
  approved: 1398,
  approvedPct: 97.9,
  queued: 24,
  queueAvgLatencySeconds: 1.2,
  rejected: 6,
  errorRatePct: 0.4,
  rejectionCodes: ['1321'],
};
