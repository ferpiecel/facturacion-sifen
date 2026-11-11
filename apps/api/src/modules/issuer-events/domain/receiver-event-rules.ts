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

/** A receiver event of the same CDC that SIFEN has not refused. Only the events registered through the platform. */
export interface PriorReceiverEvent {
  readonly kind: ReceiverEventKind;
  readonly conformityType?: ConformityType | undefined;
  readonly registeredAt: Date;
}

export type ReceiverEventRefusal =
  | { rule: 'receiver-event-already-registered'; sifenCode: string; message: string }
  | { rule: 'receiver-event-incongruent'; sifenCode: string; message: string }
  | { rule: 'receiver-event-needs-correction'; message: string }
  | { rule: 'receiver-event-window-expired'; sifenCode: string; message: string; deadline: Date };

const EXPIRED_CODE: Record<ReceiverEventKind, { de: string; dte: string }> = {
  conformity: { de: '4157', dte: '4157' },
  disconformity: { de: '4206', dte: '4206' },
  unawareness: { de: '4253', dte: '4263' },
  receipt_notice: { de: '4103', dte: '4114' },
};

const DAY_MS = 86_400_000;

/** The last instant at which the platform lets the event be registered: window days after the start, minus the margin. */
export function receiverEventDeadline(
  request: Pick<ReceiverEventRequest, 'issuedAt' | 'approvedAt'>,
  config: ReceiverEventConfig,
): Date {
  // A DTE counts from SIFEN's approval; a DE (or an unknown approval) from the issue date, which is never later.
  const start = request.approvedAt ?? wallClockToDate(request.issuedAt) ?? new Date(NaN);
  return new Date(
    start.getTime() + config.windowDays * DAY_MS - config.safetyMarginMinutes * 60_000,
  );
}

export const OPPOSITE: Partial<Record<ReceiverEventKind, ReceiverEventKind[]>> = {
  conformity: ['disconformity', 'unawareness'],
  disconformity: ['conformity', 'unawareness'],
  unawareness: ['conformity', 'disconformity'],
};
const CONCLUSIVE: ReceiverEventKind[] = ['conformity', 'disconformity', 'unawareness'];

function compatibility(
  request: ReceiverEventRequest,
  history: readonly PriorReceiverEvent[],
): ReceiverEventRefusal | null {
  const has = (kind: ReceiverEventKind) => history.some((e) => e.kind === kind);
  const conformities = history.filter((e) => e.kind === 'conformity');
  const already = (sifenCode: string, message: string): ReceiverEventRefusal => ({
    rule: 'receiver-event-already-registered',
    sifenCode,
    message,
  });
  const incongruent = (sifenCode: string, message: string): ReceiverEventRefusal => ({
    rule: 'receiver-event-incongruent',
    sifenCode,
    message,
  });
  switch (request.kind) {
    case 'receipt_notice':
      if (has('receipt_notice')) return already('4101', 'The CDC already has a receipt notice.');
      if (has('unawareness'))
        return incongruent('4113', 'A receipt notice cannot follow an unawareness.');
      if (request.approvedAt && (has('conformity') || has('disconformity'))) {
        return incongruent(
          '4113',
          'A DTE receipt notice cannot follow a conformity or disconformity.',
        );
      }
      return null;
    case 'conformity':
      if (has('unawareness'))
        return incongruent('4156', 'A conformity cannot follow an unawareness.');
      // Up to two: partial first, then total.
      if (
        conformities.some((e) => e.conformityType === 'total') ||
        (request.conformityType === 'partial' && conformities.length > 0)
      ) {
        return already('4150', 'The CDC already has its conformity events.');
      }
      return null;
    case 'disconformity':
      if (has('unawareness'))
        return incongruent('4205', 'A disconformity cannot follow an unawareness.');
      if (has('disconformity')) return already('4200', 'The CDC already has a disconformity.');
      return null;
    case 'unawareness':
      if (has('unawareness')) return already('4251', 'The CDC already has an unawareness.');
      return null;
  }
}

/**
 * The first rule the event breaks at `at`, or null when it may be registered. An event opposite to the
 * last conformity, disconformity or unawareness is a CORRECTION (MT Tabla K, HU-E9-02) and is refused here.
 */
export function validateReceiverEvent(
  request: ReceiverEventRequest,
  history: readonly PriorReceiverEvent[],
  at: Date,
  config: ReceiverEventConfig = DEFAULT_RECEIVER_EVENT_CONFIG,
  options: { correction?: boolean } = {},
): ReceiverEventRefusal | null {
  const refusal = compatibility(request, history);
  if (refusal) return refusal;
  const last = history
    .filter((e) => CONCLUSIVE.includes(e.kind))
    .sort((a, b) => b.registeredAt.getTime() - a.registeredAt.getTime())
    .at(0);
  if (!options.correction && last && OPPOSITE[last.kind]?.includes(request.kind)) {
    return {
      rule: 'receiver-event-needs-correction',
      message: 'This event contradicts the last one registered: register it as a correction.',
    };
  }
  const deadline = receiverEventDeadline(request, config);
  if (at.getTime() > deadline.getTime()) {
    const codes = EXPIRED_CODE[request.kind];
    return {
      rule: 'receiver-event-window-expired',
      sifenCode: request.approvedAt ? codes.dte : codes.de,
      message: 'The deadline to register this event has expired.',
      deadline,
    };
  }
  return null;
}
