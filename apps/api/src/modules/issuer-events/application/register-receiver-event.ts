import { requestHash } from '../../emission/domain/request-hash.js';
import type { AuditEntry } from '../../audit/application/ports/record-audit.port.js';
import {
  DEFAULT_RECEIVER_EVENT_CONFIG,
  parseReceiverEventRequest,
  validateReceiverEvent,
  type ReceiverEventConfig,
  type ReceiverEventKind,
  type ReceiverEventRefusal,
  type ReceiverEventRequest,
  type RequestIssue,
} from '../domain/receiver-event-rules.js';
import { EventKeyReusedError } from './cancel-document.js';
import { EventKeyCollisionError } from './ports/cancellation-unit-of-work.port.js';
import {
  ReceiverEventDuplicateError,
  type NewReceiverEvent,
  type ReceiverEventData,
  type ReceiverEventUnitOfWork,
  type StoredReceiverEvent,
} from './ports/receiver-event-unit-of-work.port.js';

/** The body is not a valid receiver event request; nothing was stored. */
export class ReceiverEventInvalidError extends Error {
  constructor(readonly issues: RequestIssue[]) {
    super('The receiver event request is invalid.');
    this.name = 'ReceiverEventInvalidError';
  }
}

/** A rule of the manual or of the platform refuses the event; nothing was stored. */
export class ReceiverEventRefusedError extends Error {
  constructor(readonly refusal: ReceiverEventRefusal) {
    super(refusal.message);
    this.name = 'ReceiverEventRefusedError';
  }
}

/** The event names the tenant as receiver, and the tenant has no fiscal profile (RUC and legal name) yet. */
export class ReceiverProfileMissingError extends Error {
  constructor() {
    super('The tenant has no fiscal profile to identify it as the receiver.');
    this.name = 'ReceiverProfileMissingError';
  }
}

export interface RegisterReceiverEventInput {
  tenantId: string;
  actor: AuditEntry['actor'];
  body: unknown;
  idempotencyKey: string;
}

export interface RegisteredReceiverEvent {
  eventId: string;
  kind: ReceiverEventKind;
  cdc: string;
  status: 'pending';
}

export interface RegisterReceiverEventDependencies {
  unitOfWork: ReceiverEventUnitOfWork;
  now?: () => Date;
  config?: ReceiverEventConfig;
}

/** Codes of "already has an event of this kind" (NT 019), for a duplicate caught by the unique index. */
const ALREADY_CODE: Record<ReceiverEventKind, string> = {
  conformity: '4150',
  disconformity: '4200',
  unawareness: '4251',
  receipt_notice: '4101',
};

function toStored(request: ReceiverEventRequest): {
  reason: string | null;
  data: ReceiverEventData;
} {
  const data: ReceiverEventData = { issuedAt: request.issuedAt };
  if (request.approvedAt) data.approvedAt = request.approvedAt.toISOString();
  switch (request.kind) {
    case 'conformity':
      data.conformityType = request.conformityType;
      if (request.estimatedReceiptAt) data.estimatedReceiptAt = request.estimatedReceiptAt;
      return { reason: null, data };
    case 'disconformity':
      return { reason: request.reason, data };
    case 'unawareness':
      data.receivedAt = request.receivedAt;
      return { reason: request.reason, data };
    case 'receipt_notice':
      data.receivedAt = request.receivedAt;
      data.totalPyg = request.totalPyg;
      return { reason: null, data };
  }
}

/**
 * Registers an event of the tenant as RECEIVER of a DE/DTE (HU-E9-01): inside one tenant transaction it locks
 * the CDC, applies the 45-day window and the compatibility rules of NT 019 against the events already
 * registered through the platform, and stores the event `pending` in `issuer_events` (ADR-0020). The worker
 * signs, batches and sends it like any other event. Idempotent by key.
 *
 * @throws ReceiverEventInvalidError, ReceiverEventRefusedError, ReceiverProfileMissingError, EventKeyReusedError
 */
export function createRegisterReceiverEvent(deps: RegisterReceiverEventDependencies) {
  const now = deps.now ?? (() => new Date());
  const config = deps.config ?? DEFAULT_RECEIVER_EVENT_CONFIG;

  return async function registerReceiverEvent(
    input: RegisterReceiverEventInput,
  ): Promise<RegisteredReceiverEvent> {
    const parsed = parseReceiverEventRequest(input.body);
    if (!parsed.ok) throw new ReceiverEventInvalidError(parsed.issues);
    const request = parsed.value;
    const stored = toStored(request);
    const hash = requestHash({
      action: 'receiver-event',
      kind: request.kind,
      cdc: request.cdc,
      ...stored,
    });
    try {
      return await registerOnce(input, request, stored, hash);
    } catch (error) {
      if (!(error instanceof EventKeyCollisionError)) throw error;
      return registerOnce(input, request, stored, hash);
    }
  };

  async function registerOnce(
    input: RegisterReceiverEventInput,
    request: ReceiverEventRequest,
    stored: ReturnType<typeof toStored>,
    hash: string,
  ): Promise<RegisteredReceiverEvent> {
    return deps.unitOfWork.run(input.tenantId, async (unit) => {
      const replayed = replay(await unit.findByIdempotencyKey(input.idempotencyKey), hash);
      if (replayed) return replayed;

      await unit.lockCdc(request.cdc);
      // A parallel request with the same key may have committed while this one waited for the lock.
      const late = replay(await unit.findByIdempotencyKey(input.idempotencyKey), hash);
      if (late) return late;

      const { environment, party } = await unit.receiverIdentity();
      const history = await unit.listEvents(request.cdc, environment);
      const refusal = validateReceiverEvent(request, history, now(), config);
      if (refusal) throw new ReceiverEventRefusedError(refusal);

      const data = { ...stored.data };
      if (request.kind === 'unawareness' || request.kind === 'receipt_notice') {
        if (!party) throw new ReceiverProfileMissingError();
        data.receiver = party;
      }
      const event: NewReceiverEvent = {
        environment,
        kind: request.kind,
        cdc: request.cdc,
        reason: stored.reason,
        data,
        idempotencyKey: input.idempotencyKey,
        requestHash: hash,
      };
      let id: string;
      try {
        ({ id } = await unit.insertEvent(event));
      } catch (error) {
        if (!(error instanceof ReceiverEventDuplicateError)) throw error;
        throw new ReceiverEventRefusedError({
          rule: 'receiver-event-already-registered',
          sifenCode: ALREADY_CODE[request.kind],
          message: 'The CDC already has an event of this kind.',
        });
      }
      await unit.recordAudit({
        actor: input.actor,
        action: 'receiver_event.registered',
        entity: { type: 'receiver_event', id },
        before: null,
        after: { kind: request.kind, cdc: request.cdc, status: 'pending' },
      });
      return { eventId: id, kind: request.kind, cdc: request.cdc, status: 'pending' };
    });
  }

  function replay(
    existing: StoredReceiverEvent | null,
    hash: string,
  ): RegisteredReceiverEvent | null {
    if (!existing) return null;
    if (existing.requestHash !== hash) throw new EventKeyReusedError();
    return { eventId: existing.eventId, kind: existing.kind, cdc: existing.cdc, status: 'pending' };
  }
}
