import { requestHash } from '../../emission/domain/request-hash.js';
import type { AuditEntry } from '../../audit/application/ports/record-audit.port.js';
import {
  DEFAULT_CANCEL_WINDOW,
  validateCancelReason,
  validateCancellation,
  type CancelRefusal,
  type CancelWindowConfig,
} from '../domain/cancel-rules.js';
import {
  EventKeyCollisionError,
  type CancellationUnitOfWork,
} from './ports/cancellation-unit-of-work.port.js';

export class CancelReasonInvalidError extends Error {
  constructor() {
    super('The cancellation reason must have 5 to 500 characters.');
    this.name = 'CancelReasonInvalidError';
  }
}

export class DocumentNotFoundError extends Error {
  constructor() {
    super('Document not found');
    this.name = 'DocumentNotFoundError';
  }
}

/** A rule of the manual or of the platform refuses the cancellation; nothing was stored. */
export class CancellationRefusedError extends Error {
  constructor(readonly refusal: CancelRefusal) {
    super(refusal.message);
    this.name = 'CancellationRefusedError';
  }
}

/** The document already has a cancellation that was not rejected (MT v150 4003). */
export class CancellationAlreadyRequestedError extends Error {
  constructor(readonly eventId: string) {
    super('A cancellation of this document was already requested.');
    this.name = 'CancellationAlreadyRequestedError';
  }
}

export class EventKeyReusedError extends Error {
  constructor() {
    super('Idempotency key reused with a different request');
    this.name = 'EventKeyReusedError';
  }
}

export interface CancelDocumentInput {
  tenantId: string;
  actor: AuditEntry['actor'];
  documentId: string;
  reason: unknown;
  idempotencyKey: string;
}

export interface CancelledDocumentRequest {
  eventId: string;
  documentId: string;
  status: 'pending';
}

export interface CancelDocumentDependencies {
  unitOfWork: CancellationUnitOfWork;
  now?: () => Date;
  window?: CancelWindowConfig;
}

/**
 * Requests the cancellation of an approved DTE (HU-E8-02): inside one tenant transaction it locks the
 * document, applies the manual's rules (status, 48 h / 168 h window, associated documents, one open
 * cancellation) and only then takes an event id and stores the event `pending`, so a refusal burns none.
 * The worker signs, batches and sends it; SIFEN's answer settles the document. Idempotent by key.
 *
 * @throws CancelReasonInvalidError, DocumentNotFoundError, CancellationRefusedError,
 *   CancellationAlreadyRequestedError, EventKeyReusedError
 */
export function createCancelDocument(deps: CancelDocumentDependencies) {
  const now = deps.now ?? (() => new Date());
  const window = deps.window ?? DEFAULT_CANCEL_WINDOW;

  return async function cancelDocument(
    input: CancelDocumentInput,
  ): Promise<CancelledDocumentRequest> {
    const reason = validateCancelReason(input.reason);
    if (!reason.ok) throw new CancelReasonInvalidError();
    const hash = requestHash({
      action: 'cancel',
      documentId: input.documentId,
      reason: reason.value,
    });
    try {
      return await requestOnce(input, reason.value, hash);
    } catch (error) {
      if (!(error instanceof EventKeyCollisionError)) throw error;
      return requestOnce(input, reason.value, hash);
    }
  };

  async function requestOnce(
    input: CancelDocumentInput,
    reason: string,
    hash: string,
  ): Promise<CancelledDocumentRequest> {
    return deps.unitOfWork.run(input.tenantId, async (unit) => {
      const replayed = replay(await unit.findByIdempotencyKey(input.idempotencyKey), hash);
      if (replayed) return replayed;

      const target = await unit.lockDocument(input.documentId);
      if (!target) throw new DocumentNotFoundError();
      // A parallel request with the same key may have committed while this one waited for the lock.
      const late = replay(await unit.findByIdempotencyKey(input.idempotencyKey), hash);
      if (late) return late;

      const open = await unit.findOpenCancellation(target.id);
      if (open) throw new CancellationAlreadyRequestedError(open.eventId);
      const refusal = validateCancellation(
        {
          documentType: target.documentType,
          status: target.status,
          approvedAt: target.approvedAt,
          signedAt: target.signedAt,
          liveAssociatedCdcs: await unit.listLiveAssociatedCdcs(target.cdc, target.environment),
        },
        now(),
        window,
      );
      if (refusal) throw new CancellationRefusedError(refusal);

      const { id } = await unit.insertCancellation({
        environment: target.environment,
        documentId: target.id,
        reason,
        idempotencyKey: input.idempotencyKey,
        requestHash: hash,
      });
      await unit.recordAudit({
        actor: input.actor,
        action: 'document.cancellation_requested',
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
  ): CancelledDocumentRequest | null {
    if (!stored) return null;
    if (stored.requestHash !== hash || !stored.documentId) throw new EventKeyReusedError();
    return { eventId: stored.eventId, documentId: stored.documentId, status: 'pending' };
  }
}
