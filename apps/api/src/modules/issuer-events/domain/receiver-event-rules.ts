/**
 * Rules for the events a tenant registers as the RECEIVER of a DE/DTE (HU-E9-01). Pure: no framework, no
 * clock of its own. Sources: MT v150 11.5 (groups rGeVeConf, rGeVeDisconf, rGeVeDescon, rGeVeNotRec) and
 * 11.6.3 to 11.6.6; NT 019, which prevails (ADR-0012), for the 45-day window and the compatibility rules.
 * SIFEN stays the authority: it also sees events registered outside the platform.
 */
import { parseCdc } from '../../emission/domain/cdc.js';

export const RECEIVER_EVENT_KINDS = [
  'conformity',
  'disconformity',
  'unawareness',
  'receipt_notice',
] as const;
export type ReceiverEventKind = (typeof RECEIVER_EVENT_KINDS)[number];
export type ConformityType = 'total' | 'partial';

export interface ReceiverEventConfig {
  /** NT 019: days to register an event, from the issue date (DE) or from SIFEN's approval (DTE). */
  readonly windowDays: number;
  /** MT Tabla K: days to correct a receiver event. */
  readonly correctionDays: number;
  /** Minutes taken off the limit: the event is signed a moment after the request is checked. */
  readonly safetyMarginMinutes: number;
}

export const DEFAULT_RECEIVER_EVENT_CONFIG: ReceiverEventConfig = {
  windowDays: 45,
  correctionDays: 15,
  safetyMarginMinutes: 15,
};

interface Common {
  readonly cdc: string;
  /** `dFecEmi`, `AAAA-MM-DDThh:mm:ss`, Asunción time. */
  readonly issuedAt: string;
  /** SIFEN's approval of a DTE; its presence marks the document as a DTE and moves the window start. */
  readonly approvedAt?: Date;
}

export type ReceiverEventRequest =
  | (Common & {
      kind: 'conformity';
      conformityType: ConformityType;
      /** `dFecRecep` of a partial conformity (GCO004). */
      estimatedReceiptAt?: string;
    })
  | (Common & { kind: 'disconformity'; reason: string })
  | (Common & { kind: 'unawareness'; reason: string; receivedAt: string })
  | (Common & { kind: 'receipt_notice'; receivedAt: string; totalPyg: number });

export interface RequestIssue {
  readonly field: string;
  readonly rule: string;
}

export type ParsedReceiverEvent =
  { ok: true; value: ReceiverEventRequest } | { ok: false; issues: RequestIssue[] };

const WALL_CLOCK = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/;
const OFFSET_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
/** Paraguay is UTC-3 all year since October 2024 (as `asuncionWallClock`). */
const ASUNCION_OFFSET = '-03:00';
const MAX_TOTAL = 999_999_999_999_999;

function wallClockToDate(value: string): Date | null {
  if (!WALL_CLOCK.test(value)) return null;
  const date = new Date(`${value}${ASUNCION_OFFSET}`);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** A real calendar date and time in the manual's format: 2026-02-31 would roll over, so it is compared back. */
function isRealWallClock(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const date = wallClockToDate(value);
  if (!date) return false;
  return new Date(date.getTime() - 3 * 3_600_000).toISOString().slice(0, 19) === value;
}

function instantOf(value: unknown): Date | null {
  if (typeof value !== 'string') return null;
  if (OFFSET_INSTANT.test(value)) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  return isRealWallClock(value) ? wallClockToDate(value) : null;
}

/** GDI004, GED011: `mOtEve` of 5 to 500 characters. */
function parseReason(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const reason = value.trim();
  return reason.length >= 5 && reason.length <= 500 ? reason : null;
}

/** Validates the body of a receiver event request. Reports every problem it finds, not only the first. */
export function parseReceiverEventRequest(raw: unknown): ParsedReceiverEvent {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, issues: [{ field: 'body', rule: 'body-invalid' }] };
  }
  const body = raw as Record<string, unknown>;
  const issues: RequestIssue[] = [];
  const issue = (field: string, rule: string) => issues.push({ field, rule });

  const kind = RECEIVER_EVENT_KINDS.find((k) => k === body.kind);
  if (!kind) issue('kind', 'kind-invalid');

  let cdc = '';
  try {
    if (typeof body.cdc !== 'string') throw new TypeError('cdc');
    parseCdc(body.cdc);
    cdc = body.cdc;
  } catch {
    issue('cdc', 'cdc-invalid');
  }
  const issuedAt = isRealWallClock(body.issuedAt) ? body.issuedAt : null;
  if (!issuedAt) issue('issuedAt', 'issued-at-invalid');
  else if (cdc && issuedAt.slice(0, 10).replaceAll('-', '') !== cdc.slice(25, 33)) {
    issue('issuedAt', 'issued-at-cdc-mismatch');
  }

  let approvedAt: Date | undefined;
  if (body.approvedAt !== undefined) {
    const instant = instantOf(body.approvedAt);
    if (instant) approvedAt = instant;
    else issue('approvedAt', 'approved-at-invalid');
  }

  const receivedAt = (): string => {
    if (!isRealWallClock(body.receivedAt)) {
      issue('receivedAt', 'received-at-invalid');
      return '';
    }
    if (issuedAt && body.receivedAt < issuedAt) issue('receivedAt', 'received-at-before-issue');
    return body.receivedAt;
  };
  const reason = (): string => {
    const value = parseReason(body.reason);
    if (value === null) issue('reason', 'reason-length');
    return value ?? '';
  };

  const common = { cdc, issuedAt: issuedAt ?? '', ...(approvedAt ? { approvedAt } : {}) };
  let value: ReceiverEventRequest | undefined;
  switch (kind) {
    case 'conformity': {
      const type = body.conformityType;
      if (type !== 'total' && type !== 'partial') {
        issue('conformityType', 'conformity-type-invalid');
        break;
      }
      let estimatedReceiptAt: string | undefined;
      if (type === 'partial') {
        if (isRealWallClock(body.estimatedReceiptAt)) estimatedReceiptAt = body.estimatedReceiptAt;
        else issue('estimatedReceiptAt', 'estimated-receipt-required');
      } else if (body.estimatedReceiptAt !== undefined) {
        issue('estimatedReceiptAt', 'estimated-receipt-not-allowed');
      }
      value = {
        ...common,
        kind,
        conformityType: type,
        ...(estimatedReceiptAt ? { estimatedReceiptAt } : {}),
      };
      break;
    }
    case 'disconformity':
      value = { ...common, kind, reason: reason() };
      break;
    case 'unawareness':
      value = { ...common, kind, reason: reason(), receivedAt: receivedAt() };
      break;
    case 'receipt_notice': {
      const received = receivedAt();
      const total = body.totalPyg;
      if (typeof total !== 'number' || !Number.isFinite(total) || total < 0 || total > MAX_TOTAL) {
        issue('totalPyg', 'total-invalid');
      }
      value = { ...common, kind, receivedAt: received, totalPyg: Number(total) };
      break;
    }
    case undefined:
      break;
  }
  return issues.length > 0 || !value ? { ok: false, issues } : { ok: true, value };
}
