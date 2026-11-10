import { isReceivedDocumentStatus } from '../domain/received-document-status.js';
import { isReceivedDocumentSource } from '../domain/source.js';
import type {
  ReceivedDocumentListCursor,
  ReceivedDocumentListQuery,
  ReceivedDocumentQuery,
  ReceivedDocumentSummary,
} from './ports/received-document-query.port.js';

export const DEFAULT_LIST_LIMIT = 50;
export const MAX_LIST_LIMIT = 200;

/** A query parameter is malformed; `field` names it, `message` never echoes the value. */
export class InvalidReceivedDocumentQueryError extends Error {
  constructor(
    readonly field: string,
    message: string,
  ) {
    super(message);
    this.name = 'InvalidReceivedDocumentQueryError';
  }
}

export interface ReceivedDocumentPage {
  readonly items: readonly ReceivedDocumentSummary[];
  readonly nextCursor: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STORE_TIMESTAMP = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{1,6})?[+-]\d{2}(?::?\d{2})?$/;
const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/;
const RUC = /^(\d{5,8})(?:-\d)?$/;
const DAY_MS = 86_400_000;

function encodeCursor(item: ReceivedDocumentSummary): string {
  return Buffer.from(JSON.stringify([item.createdAtKey, item.document.id])).toString('base64url');
}

function decodeCursor(raw: string): ReceivedDocumentListCursor | undefined {
  try {
    const [createdAt, id] = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as unknown[];
    return typeof createdAt === 'string' &&
      STORE_TIMESTAMP.test(createdAt) &&
      typeof id === 'string' &&
      UUID.test(id)
      ? { createdAt, id }
      : undefined;
  } catch {
    return undefined;
  }
}

const calendarDate = (field: string, value: unknown): Date => {
  const date =
    typeof value === 'string' && CALENDAR_DATE.test(value) ? new Date(`${value}Z`) : null;
  // `new Date('2026-02-31Z')` rolls over silently; the round trip catches it.
  if (date === null || Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new InvalidReceivedDocumentQueryError(field, `${field} must be a date (YYYY-MM-DD)`);
  }
  return date;
};

/**
 * `GET /v1/received-documents`: validates the raw query string, then keyset-pages the read model.
 * Dates (`issued_from`, `issued_to`) are calendar days compared against the stored issue date,
 * which ingestion records at UTC midnight; both bounds are inclusive.
 */
export function createListReceivedDocuments(deps: { readonly query: ReceivedDocumentQuery }) {
  return async (
    tenantId: string,
    raw: Readonly<Record<string, unknown>>,
  ): Promise<ReceivedDocumentPage> => {
    const query: {
      -readonly [K in keyof ReceivedDocumentListQuery]: ReceivedDocumentListQuery[K];
    } = { limit: DEFAULT_LIST_LIMIT };
    const bad = (field: string, message: string) =>
      new InvalidReceivedDocumentQueryError(field, message);
    const single = (field: string): string | undefined => {
      const value = raw[field];
      if (value === undefined) return undefined;
      if (typeof value !== 'string') throw bad(field, `${field} must be a single value`);
      return value;
    };

    const limit = single('limit');
    if (limit !== undefined) {
      const parsed = Number(limit);
      if (!/^\d+$/.test(limit) || parsed < 1 || parsed > MAX_LIST_LIMIT) {
        throw bad('limit', `limit must be an integer from 1 to ${String(MAX_LIST_LIMIT)}`);
      }
      query.limit = parsed;
    }
    const cursor = single('cursor');
    if (cursor !== undefined) {
      const after = decodeCursor(cursor);
      if (after === undefined) throw bad('cursor', 'cursor is not valid');
      query.after = after;
    }
    const status = single('status');
    if (status !== undefined) {
      if (!isReceivedDocumentStatus(status)) throw bad('status', 'status is not a known status');
      query.status = status;
    }
    const source = single('source');
    if (source !== undefined) {
      if (!isReceivedDocumentSource(source)) throw bad('source', 'source is not a known source');
      query.source = source;
    }
    const ruc = single('issuer_ruc');
    if (ruc !== undefined) {
      const base = RUC.exec(ruc)?.[1];
      if (base === undefined) throw bad('issuer_ruc', 'issuer_ruc must look like 80000001[-8]');
      query.issuerRucBase = base;
    }
    const from = single('issued_from');
    if (from !== undefined) query.issuedFrom = calendarDate('issued_from', from);
    const to = single('issued_to');
    if (to !== undefined) {
      query.issuedBefore = new Date(calendarDate('issued_to', to).getTime() + DAY_MS);
    }
    const own = single('is_own_receiver');
    if (own !== undefined) {
      if (own !== 'true' && own !== 'false') throw bad('is_own_receiver', 'must be true or false');
      query.isOwnReceiver = own === 'true';
    }
    const prefix = single('cdc_prefix');
    if (prefix !== undefined) {
      if (!/^\d{1,44}$/.test(prefix)) throw bad('cdc_prefix', 'cdc_prefix must be 1 to 44 digits');
      query.cdcPrefix = prefix;
    }
    const since = single('updated_since');
    if (since !== undefined) {
      const at = new Date(since);
      if (Number.isNaN(at.getTime()) || !/^\d{4}-\d{2}-\d{2}T/.test(since)) {
        throw bad('updated_since', 'updated_since must be an ISO 8601 timestamp');
      }
      query.updatedSince = at;
    }

    const rows = await deps.query.list(tenantId, query);
    const items = rows.slice(0, query.limit);
    return {
      items,
      nextCursor: rows.length > query.limit ? encodeCursor(items[items.length - 1]) : null,
    };
  };
}
