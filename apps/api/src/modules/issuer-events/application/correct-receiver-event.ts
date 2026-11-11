import { requestHash } from '../../emission/domain/request-hash.js';
import type { AuditEntry } from '../../audit/application/ports/record-audit.port.js';
import {
  validateCorrection,
  validateCorrectionReason,
  type CorrectionRefusal,
} from '../domain/receiver-correction-rules.js';
import {
  DEFAULT_RECEIVER_EVENT_CONFIG,
  parseReceiverEventRequest,
  type ReceiverEventConfig,
  type ReceiverEventKind,
} from '../domain/receiver-event-rules.js';
import { EventKeyReusedError } from './cancel-document.js';
import { EventKeyCollisionError } from './ports/cancellation-unit-of-work.port.js';
import {
  ReceiverEventDuplicateError,
  type CorrectionUnitOfWork,
  type NewReceiverEvent,
  type StoredReceiverEvent,
} from './ports/receiver-event-unit-of-work.port.js';
import {
  ALREADY_CODE,
  ReceiverEventInvalidError,
  ReceiverEventRefusedError,
  ReceiverProfileMissingError,
  toStored,
} from './register-receiver-event.js';

/** The tenant has no receiver event with that id. */
export class ReceiverEventNotFoundError extends Error {
  constructor() {
    super('Receiver event not found.');
    this.name = 'ReceiverEventNotFoundError';
  }
}

/** A correction rule (MT Tabla K) refuses the replacement; nothing was stored. */
export class ReceiverCorrectionRefusedError extends Error {
  constructor(readonly refusal: CorrectionRefusal) {
    super(refusal.message);
    this.name = 'ReceiverCorrectionRefusedError';
  }
}

export interface CorrectReceiverEventInput {
  tenantId: string;
  actor: AuditEntry['actor'];
  /** The approved event being corrected. */
  eventId: string;
  /** The replacement event (same shape as a registration) plus `correctionReason`. */
  body: unknown;
  idempotencyKey: string;
}

export interface CorrectedReceiverEvent {
  eventId: string;
  correctsEventId: string;
  kind: ReceiverEventKind;
  cdc: string;
  status: 'pending';
}

export interface CorrectReceiverEventDependencies {
  unitOfWork: CorrectionUnitOfWork;
  now?: () => Date;
  config?: ReceiverEventConfig;
}

/**
 * Corrects an approved receiver event (HU-E9-02): stores the opposite event `pending`, linked to the original
 * and with the justification, once the correction rules hold (original approved, latest, not a correction,
 * not corrected yet, inside the window). The worker signs and sends it like any receiver event. Idempotent by key.
 *
 * @throws ReceiverEventInvalidError, ReceiverEventNotFoundError, ReceiverCorrectionRefusedError,
 *   ReceiverEventRefusedError, ReceiverProfileMissingError, EventKeyReusedError
 */
export function createCorrectReceiverEvent(deps: CorrectReceiverEventDependencies) {
  const now = deps.now ?? (() => new Date());
  const config = deps.config ?? DEFAULT_RECEIVER_EVENT_CONFIG;

  return async function correctReceiverEvent(
    input: CorrectReceiverEventInput,
  ): Promise<CorrectedReceiverEvent> {
    const parsed = parseReceiverEventRequest(input.body);
    const issues = parsed.ok ? [] : [...parsed.issues];
    const rawReason = (input.body as { correctionReason?: unknown } | null)?.correctionReason;
    const reason = validateCorrectionReason(rawReason);
    if (!reason.ok) issues.push({ field: 'correctionReason', rule: 'correction-reason-invalid' });
    if (!parsed.ok || !reason.ok) throw new ReceiverEventInvalidError(issues);

    const request = parsed.value;
    const stored = toStored(request);
    const hash = requestHash({
      action: 'receiver-event-correction',
      originalEventId: input.eventId,
      correctionReason: reason.value,
      kind: request.kind,
      cdc: request.cdc,
      ...stored,
    });
    const once = () => correctOnce(input, request, stored, reason.value, hash);
    try {
      return await once();
    } catch (error) {
      if (!(error instanceof EventKeyCollisionError)) throw error;
      return once();
    }
  };

  async function correctOnce(
    input: CorrectReceiverEventInput,
    request: Extract<ReturnType<typeof parseReceiverEventRequest>, { ok: true }>['value'],
    stored: ReturnType<typeof toStored>,
    correctionReason: string,
    hash: string,
  ): Promise<CorrectedReceiverEvent> {
    return deps.unitOfWork.run(input.tenantId, async (unit) => {
      const replayed = replay(await unit.findByIdempotencyKey(input.idempotencyKey), input, hash);
      if (replayed) return replayed;

      const cdc = await unit.cdcOfEvent(input.eventId);
      if (!cdc) throw new ReceiverEventNotFoundError();
      await unit.lockCdc(cdc);
      // A parallel request with the same key may have committed while this one waited for the lock.
      const late = replay(await unit.findByIdempotencyKey(input.idempotencyKey), input, hash);
      if (late) return late;

      const original = await unit.findCorrectable(input.eventId);
      if (!original) throw new ReceiverEventNotFoundError();
      if (request.cdc !== original.cdc) {
        throw new ReceiverEventInvalidError([{ field: 'cdc', rule: 'cdc-differs-from-original' }]);
      }

      const { environment, party } = await unit.receiverIdentity();
      const history = await unit.listEvents(original.cdc, environment);
      const refusal = validateCorrection(original, request, history, now(), config);
      if (refusal) {
        throw refusal.rule.startsWith('correction-')
          ? new ReceiverCorrectionRefusedError(refusal)
          : new ReceiverEventRefusedError(
              refusal as ConstructorParameters<typeof ReceiverEventRefusedError>[0],
            );
      }

      const data = { ...stored.data };
      if (request.kind === 'unawareness' || request.kind === 'receipt_notice') {
        if (!party) throw new ReceiverProfileMissingError();
        data.receiver = party;
      }
      const event: NewReceiverEvent = {
        environment,
        kind: request.kind,
        cdc: original.cdc,
        reason: stored.reason,
        data,
        idempotencyKey: input.idempotencyKey,
        requestHash: hash,
        correction: { originalEventId: input.eventId, reason: correctionReason },
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
        action: 'receiver_event.corrected',
        entity: { type: 'receiver_event', id },
        before: null,
        after: {
          kind: request.kind,
          cdc: original.cdc,
          status: 'pending',
          corrects: input.eventId,
        },
      });
      return {
        eventId: id,
        correctsEventId: input.eventId,
        kind: request.kind,
        cdc: original.cdc,
        status: 'pending',
      };
    });
  }

  function replay(
    existing: StoredReceiverEvent | null,
    input: CorrectReceiverEventInput,
    hash: string,
  ): CorrectedReceiverEvent | null {
    if (!existing) return null;
    if (existing.requestHash !== hash) throw new EventKeyReusedError();
    return {
      eventId: existing.eventId,
      correctsEventId: input.eventId,
      kind: existing.kind,
      cdc: existing.cdc,
      status: 'pending',
    };
  }
}
