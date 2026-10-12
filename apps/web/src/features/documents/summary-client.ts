/**
 * Browser client of the portal period summary (`GET /portal/summary?from&to`, HU-E12-03), through the same-origin
 * proxy and the shared session handling of the documents client.
 */
import { createPortalHttp, type Failure, type PortalHttpOptions } from './portal-http';

export interface SummaryByType {
  /** `null` for a SIFEN type the portal has no code for. */
  type: 'FE' | 'NCE' | 'NDE' | 'AFE' | null;
  count: number;
  /** Decimal string in PYG. */
  amountPyg: string;
}

export interface SummaryByStatus {
  status: string;
  count: number;
  amountPyg: string;
}

export interface PeriodSummary {
  /** `YYYY-MM-DD`, inclusive. */
  from: string;
  to: string;
  totals: { count: number; amountPyg: string; otherCurrencyCount: number };
  byType: SummaryByType[];
  byStatus: SummaryByStatus[];
  rejected: { count: number; topCodes: { code: string; count: number }[] };
  /** Documents waiting for SIFEN, against the 72 h transmission deadline. */
  pending: { count: number; overdue: number; dueSoon: number; oldestDeadline: string | null };
  /** The comparison period, for the growth indicator. */
  previous: { count: number };
}

export interface SummaryQuery {
  from?: string;
  to?: string;
}

export type SummaryResult = { kind: 'ok'; summary: PeriodSummary } | Failure;

export interface SummaryClient {
  get: (query: SummaryQuery) => Promise<SummaryResult>;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const isSummary = (data: unknown): data is PeriodSummary =>
  isObject(data) &&
  isObject(data.totals) &&
  Array.isArray(data.byStatus) &&
  isObject(data.rejected) &&
  isObject(data.pending) &&
  isObject(data.previous);

export function createSummaryClient({
  baseUrl = '/api/portal/summary',
  ...http
}: PortalHttpOptions & { baseUrl?: string } = {}): SummaryClient {
  const { run } = createPortalHttp(http);
  return {
    get: ({ from, to }) => {
      const params = new URLSearchParams();
      if (from) params.set('from', from);
      if (to) params.set('to', to);
      const query = params.toString();
      return run<SummaryResult>(query ? `${baseUrl}?${query}` : baseUrl, async (response) => {
        if (!response.ok) return { kind: 'unavailable' };
        const data: unknown = await response.json();
        return isSummary(data) ? { kind: 'ok', summary: data } : { kind: 'unavailable' };
      });
    },
  };
}

/** The shared browser client of the period summary. */
export const summaryClient = createSummaryClient();
