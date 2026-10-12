import { isCalendarDay } from './calendar-day.js';
import { isPortalDocumentStatus } from './document-status.js';
import {
  documentTypeCode,
  PORTAL_DOCUMENT_TYPES,
  type PortalDocumentType,
} from './document-type.js';

export const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 20;
const MAX_QUERY_LENGTH = 100;

export interface DocumentListFilter {
  documentType?: number;
  status?: string;
  /** Inclusive calendar days in Paraguay time, `YYYY-MM-DD`. */
  from?: string;
  to?: string;
  q?: string;
  page: number;
  pageSize: number;
}

/** A filter the caller sent is not valid; the message is safe to show. */
export class InvalidListQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidListQueryError';
  }
}

function single(raw: Record<string, unknown>, name: string): string | undefined {
  const value = raw[name];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new InvalidListQueryError(`${name} must be a single value`);
  return value;
}

function day(raw: Record<string, unknown>, name: string): string | undefined {
  const value = single(raw, name);
  if (value === undefined) return undefined;
  if (!isCalendarDay(value)) throw new InvalidListQueryError(`${name} must be a YYYY-MM-DD date`);
  return value;
}

function integer(raw: Record<string, unknown>, name: string, fallback: number, max: number) {
  const value = single(raw, name);
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!/^\d+$/.test(value) || parsed < 1 || parsed > max) {
    throw new InvalidListQueryError(`${name} must be an integer between 1 and ${String(max)}`);
  }
  return parsed;
}

/** @throws InvalidListQueryError for any value the list does not accept. */
export function parseListQuery(raw: Record<string, unknown>): DocumentListFilter {
  const filter: DocumentListFilter = {
    page: integer(raw, 'page', 1, Number.MAX_SAFE_INTEGER),
    pageSize: integer(raw, 'pageSize', DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE),
  };
  const type = single(raw, 'type');
  if (type !== undefined) {
    if (!(PORTAL_DOCUMENT_TYPES as string[]).includes(type)) {
      throw new InvalidListQueryError(`type must be one of ${PORTAL_DOCUMENT_TYPES.join(', ')}`);
    }
    filter.documentType = documentTypeCode(type as PortalDocumentType);
  }
  const status = single(raw, 'status');
  if (status !== undefined) {
    if (!isPortalDocumentStatus(status)) throw new InvalidListQueryError('status is not valid');
    filter.status = status;
  }
  filter.from = day(raw, 'from');
  filter.to = day(raw, 'to');
  if (filter.from && filter.to && filter.from > filter.to) {
    throw new InvalidListQueryError('from must not be after to');
  }
  const q = single(raw, 'q')?.trim();
  if (q && q.length > MAX_QUERY_LENGTH) throw new InvalidListQueryError('q is too long');
  if (q) filter.q = q;
  return filter;
}
