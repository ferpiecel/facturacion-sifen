import { requestHash } from '../../emission/domain/request-hash.js';
import type { AuditEntry } from '../../audit/application/ports/record-audit.port.js';
import { validateCancelReason } from '../domain/cancel-rules.js';
import {
  validateNomination,
  type NominationReceiver,
  type NominationRefusal,
} from '../domain/nominate-rules.js';
import { DocumentNotFoundError, EventKeyReusedError } from './cancel-document.js';
import { EventKeyCollisionError } from './ports/cancellation-unit-of-work.port.js';
import type { NominationUnitOfWork } from './ports/nomination-unit-of-work.port.js';

export class NominationReasonInvalidError extends Error {
  constructor() {
    super('The nomination reason must have 5 to 500 characters.');
    this.name = 'NominationReasonInvalidError';
  }
}

/** A rule of the manual refuses the nomination; nothing was stored. */
export class NominationRefusedError extends Error {
  constructor(readonly refusal: NominationRefusal) {
    super(refusal.message);
    this.name = 'NominationRefusedError';
  }
}

/** The document already has a nomination that was not rejected (MT v150 4453). */
export class NominationAlreadyRequestedError extends Error {
  constructor(readonly eventId: string) {
    super('A nomination of this document was already requested.');
    this.name = 'NominationAlreadyRequestedError';
  }
}

export interface NominateDocumentInput {
  tenantId: string;
  actor: AuditEntry['actor'];
  documentId: string;
  reason: unknown;
  /** Already validated by the caller (fields by receiver nature). */
  receiver: NominationReceiver;
  idempotencyKey: string;
}

export interface NominatedDocumentRequest {
  eventId: string;
  documentId: string;
  status: 'pending';
}

export interface NominateDocumentDependencies {
  unitOfWork: NominationUnitOfWork;
}

/**
 * Requests the nomination of an approved FE issued to an unnamed receiver (HU-E8-05): inside one tenant
 * transaction it locks the document, applies the manual's rules (FE, approved, unnamed receiver, one open
 * nomination) and only then takes an event id and stores the event `pending`, so a refusal burns none.
 * The worker signs, batches and sends it. Idempotent by key.
 *
 * @throws NominationReasonInvalidError, DocumentNotFoundError, NominationRefusedError,
 *   NominationAlreadyRequestedError, EventKeyReusedError
 */
export function createNominateDocument(deps: NominateDocumentDependencies) {
  return async function nominateDocument(
    input: NominateDocumentInput,
  ): Promise<NominatedDocumentRequest> {
    const reason = validateCancelReason(input.reason);
    if (!reason.ok) throw new NominationReasonInvalidError();
    const hash = requestHash({
      action: 'nominate',
      documentId: input.documentId,
      reason: reason.value,
      receiver: input.receiver,
    });
    try {
      return await requestOnce(input, reason.value, hash);
    } catch (error) {
      if (!(error instanceof EventKeyCollisionError)) throw error;
      return requestOnce(input, reason.value, hash);
    }
  };

  async function requestOnce(
    input: NominateDocumentInput,
    reason: string,
    hash: string,
  ): Promise<NominatedDocumentRequest> {
    return deps.unitOfWork.run(input.tenantId, async (unit) => {
      const replayed = replay(await unit.findByIdempotencyKey(input.idempotencyKey), hash);
      if (replayed) return replayed;

      const target = await unit.lockDocument(input.documentId);
      if (!target) throw new DocumentNotFoundError();
      // A parallel request with the same key may have committed while this one waited for the lock.
      const late = replay(await unit.findByIdempotencyKey(input.idempotencyKey), hash);
      if (late) return late;

      const open = await unit.findOpenNomination(target.id);
      if (open) throw new NominationAlreadyRequestedError(open.eventId);
      const refusal = validateNomination(target);
      if (refusal) throw new NominationRefusedError(refusal);

      const { id } = await unit.insertNomination({
        environment: target.environment,
        documentId: target.id,
        reason,
        receiver: input.receiver,
        idempotencyKey: input.idempotencyKey,
        requestHash: hash,
      });
      await unit.recordAudit({
        actor: input.actor,
        action: 'document.nomination_requested',
        entity: { type: 'document', id: target.id },
        before: null,
        after: { eventId: id, status: 'pending' },
      });
      return { eventId: id, documentId: target.id, status: 'pending' };
    });
  }

  function replay(
    stored: { eventId: string; documentId: string | null; requestHash: string } | null,
    hash: string,
  ): NominatedDocumentRequest | null {
    if (!stored) return null;
    if (stored.requestHash !== hash || !stored.documentId) throw new EventKeyReusedError();
    return { eventId: stored.eventId, documentId: stored.documentId, status: 'pending' };
  }
}
