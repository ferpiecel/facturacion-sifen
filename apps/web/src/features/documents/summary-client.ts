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

const isNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);
const isDecimal = (value: unknown): value is string =>
  typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value));
const isRow = (row: unknown, key: 'type' | 'status'): boolean =>
  isObject(row) && isNumber(row.count) && isDecimal(row.amountPyg) && key in row;

const isSummary = (data: unknown): data is PeriodSummary =>
  isObject(data) &&
  isObject(data.totals) &&
  isNumber(data.totals.count) &&
  isDecimal(data.totals.amountPyg) &&
  isNumber(data.totals.otherCurrencyCount) &&
  Array.isArray(data.byType) &&
  data.byType.every((row) => isRow(row, 'type')) &&
  Array.isArray(data.byStatus) &&
  data.byStatus.every((row) => isRow(row, 'status')) &&
  isObject(data.rejected) &&
  isNumber(data.rejected.count) &&
  Array.isArray(data.rejected.topCodes) &&
  data.rejected.topCodes.every(
    (top) => isObject(top) && typeof top.code === 'string' && isNumber(top.count),
  ) &&
  isObject(data.pending) &&
  isNumber(data.pending.count) &&
  isNumber(data.pending.overdue) &&
  isNumber(data.pending.dueSoon) &&
  (data.pending.oldestDeadline === null || typeof data.pending.oldestDeadline === 'string') &&
  isObject(data.previous) &&
  isNumber(data.previous.count);

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
