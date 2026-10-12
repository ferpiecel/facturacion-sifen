// MOCK DATA (debt, HU-E12-03): the period indicators of the documents explorer need a summary endpoint that does
// not exist yet. The list and the detail read the real API; only this fixture is still an example, and the
// screen labels it "Datos de ejemplo".

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
