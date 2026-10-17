/**
 * Browser client of the documents that need action (`GET /portal/attention`, HU-E12-04), through the same-origin
 * proxy and the shared session handling of the documents client.
 */
import type { DocumentItem } from '../documents/documents-client';
import { createPortalHttp, type Failure, type PortalHttpOptions } from '../documents/portal-http';

export const ATTENTION_REASONS = ['overdue', 'held', 'rejected', 'due_soon'] as const;
export type AttentionReason = (typeof ATTENTION_REASONS)[number];

export interface AttentionItem extends DocumentItem {
  /** Most urgent first. */
  reasons: AttentionReason[];
  /** End of the 72 h transmission window; `null` for a document that was never signed. */
  deadline: string | null;
  /** Hours left to the deadline, zero once it has passed. */
  hoursRemaining: number | null;
  /** Plain code of why the pipeline stopped on the document. */
  hold: string | null;
  /** SIFEN's own words for the rejection. */
  rejectionReason: string | null;
}

export interface AttentionPage {
  items: AttentionItem[];
  total: number;
  /** The list holds fewer documents than `total`. */
  truncated: boolean;
}

export type AttentionResult = { kind: 'ok'; page: AttentionPage } | Failure;

export interface AttentionClient {
  get: () => Promise<AttentionResult>;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;
const isNullable = (value: unknown, type: 'string' | 'number') =>
  value === null || typeof value === typeof (type === 'string' ? '' : 0);

const isItem = (item: unknown): item is AttentionItem =>
  isObject(item) &&
  typeof item.id === 'string' &&
  typeof item.cdc === 'string' &&
  typeof item.number === 'string' &&
  typeof item.issuedAt === 'string' &&
  typeof item.receiverName === 'string' &&
  typeof item.total === 'string' &&
  typeof item.status === 'string' &&
  Array.isArray(item.reasons) &&
  item.reasons.length > 0 &&
  item.reasons.every((r) => (ATTENTION_REASONS as readonly unknown[]).includes(r)) &&
  isNullable(item.deadline, 'string') &&
  isNullable(item.hoursRemaining, 'number') &&
  isNullable(item.hold, 'string') &&
  isNullable(item.rejectionReason, 'string');

const isPage = (data: unknown): data is AttentionPage =>
  isObject(data) &&
  Array.isArray(data.items) &&
  data.items.every(isItem) &&
  typeof data.total === 'number' &&
  typeof data.truncated === 'boolean';

export function createAttentionClient({
  baseUrl = '/api/portal/attention',
  ...http
}: PortalHttpOptions & { baseUrl?: string } = {}): AttentionClient {
  const { run } = createPortalHttp(http);
  return {
    get: () =>
      run<AttentionResult>(baseUrl, async (response) => {
        if (!response.ok) return { kind: 'unavailable' };
        const data: unknown = await response.json();
        return isPage(data) ? { kind: 'ok', page: data } : { kind: 'unavailable' };
      }),
  };
}

/** The shared browser client of the documents that need action. */
export const attentionClient = createAttentionClient();
