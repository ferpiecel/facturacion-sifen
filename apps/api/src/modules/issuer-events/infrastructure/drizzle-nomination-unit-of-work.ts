import { and, eq, ne } from 'drizzle-orm';
import {
  documents,
  issuerEvents,
  withTenantTransaction,
  type Database,
  type TenantTx,
} from '@sifen/db';
import { recordAudit } from '../../audit/infrastructure/record-audit.js';
import { EventKeyCollisionError } from '../application/ports/cancellation-unit-of-work.port.js';
import type {
  NominationUnit,
  NominationUnitOfWork,
} from '../application/ports/nomination-unit-of-work.port.js';
import { first, isKeyCollision, takeEventId } from './drizzle-event-support.js';

/** `receiver.kind` of the stored request body (HU-E5 `POST /v1/documents`), or null when it says nothing usable. */
function receiverKindOf(payload: unknown): 'unnamed' | 'named' | null {
  const receiver = (payload as { receiver?: { kind?: unknown } } | null)?.receiver;
  return receiver?.kind === 'unnamed' || receiver?.kind === 'named' ? receiver.kind : null;
}

function createUnit(tx: TenantTx, tenantId: string): NominationUnit {
  return {
    async findByIdempotencyKey(key) {
      const row = await tx
        .select({
          id: issuerEvents.id,
          documentId: issuerEvents.documentId,
          requestHash: issuerEvents.requestHash,
        })
        .from(issuerEvents)
        .where(and(eq(issuerEvents.tenantId, tenantId), eq(issuerEvents.idempotencyKey, key)))
        .then(first);
      if (!row?.requestHash) return null;
      return { eventId: row.id, documentId: row.documentId, requestHash: row.requestHash };
    },
    async lockDocument(documentId) {
      const row = await tx
        .select({
          id: documents.id,
          cdc: documents.cdc,
          environment: documents.environment,
          documentType: documents.documentType,
          status: documents.status,
          payload: documents.payload,
        })
        .from(documents)
        .where(and(eq(documents.tenantId, tenantId), eq(documents.id, documentId)))
        .for('no key update')
        .then(first);
      if (!row) return null;
      const { payload, ...target } = row;
      return { ...target, receiverKind: receiverKindOf(payload) };
    },
    async findOpenNomination(documentId) {
      const row = await tx
        .select({ id: issuerEvents.id })
        .from(issuerEvents)
        .where(
          and(
            eq(issuerEvents.tenantId, tenantId),
            eq(issuerEvents.documentId, documentId),
            eq(issuerEvents.kind, 'nomination'),
            ne(issuerEvents.status, 'rejected'),
          ),
        )
        .then(first);
      return row ? { eventId: row.id } : null;
    },
    async insertNomination(event) {
      const eventId = await takeEventId(tx, tenantId, event.environment);
      try {
        const [row] = await tx
          .insert(issuerEvents)
          .values({
            tenantId,
            environment: event.environment,
            kind: 'nomination',
            eventId,
            documentId: event.documentId,
            reason: event.reason,
            nomination: event.receiver,
            idempotencyKey: event.idempotencyKey,
            requestHash: event.requestHash,
          })
          .returning({ id: issuerEvents.id });
        return { id: row.id };
      } catch (error) {
        if (isKeyCollision(error)) throw new EventKeyCollisionError();
        throw error;
      }
    },
    recordAudit: (entry) => recordAudit(tx, entry),
  };
}

/** Runs the nomination inside `withTenantTransaction`, so RLS scopes every query to the tenant. */
export function createDrizzleNominationUnitOfWork(db: Database): NominationUnitOfWork {
  return {
    run: (tenantId, work) =>
      withTenantTransaction(db, tenantId, (tx) => work(createUnit(tx, tenantId))),
  };
}
