import { and, eq, ne, notInArray } from 'drizzle-orm';
import {
  documents,
  issuerEvents,
  withTenantTransaction,
  type Database,
  type TenantTx,
} from '@sifen/db';
import { recordAudit } from '../../audit/infrastructure/record-audit.js';
import {
  EventKeyCollisionError,
  type CancellationUnit,
  type CancellationUnitOfWork,
} from '../application/ports/cancellation-unit-of-work.port.js';
import { first, isKeyCollision, takeEventId } from './drizzle-event-support.js';

function createUnit(tx: TenantTx, tenantId: string): CancellationUnit {
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
          approvedAt: documents.approvedAt,
          signedAt: documents.signedAt,
        })
        .from(documents)
        .where(and(eq(documents.tenantId, tenantId), eq(documents.id, documentId)))
        .for('no key update')
        .then(first);
      return row ?? null;
    },
    async listLiveAssociatedCdcs(cdc, environment) {
      const rows = await tx
        .select({ cdc: documents.cdc })
        .from(documents)
        .where(
          and(
            eq(documents.tenantId, tenantId),
            eq(documents.environment, environment),
            eq(documents.associatedCdc, cdc),
            // Rejected never existed for SIFEN, corrected was replaced, cancelled/voided are gone.
            notInArray(documents.status, ['rejected', 'corrected', 'cancelled', 'number_voided']),
          ),
        )
        .orderBy(documents.cdc);
      return rows.map((r) => r.cdc);
    },
    async findOpenCancellation(documentId) {
      const row = await tx
        .select({ id: issuerEvents.id })
        .from(issuerEvents)
        .where(
          and(
            eq(issuerEvents.tenantId, tenantId),
            eq(issuerEvents.documentId, documentId),
            eq(issuerEvents.kind, 'cancellation'),
            ne(issuerEvents.status, 'rejected'),
          ),
        )
        .then(first);
      return row ? { eventId: row.id } : null;
    },
    async insertCancellation(event) {
      const eventId = await takeEventId(tx, tenantId, event.environment);
      try {
        const [row] = await tx
          .insert(issuerEvents)
          .values({
            tenantId,
            environment: event.environment,
            kind: 'cancellation',
            eventId,
            documentId: event.documentId,
            reason: event.reason,
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

/** Runs the cancellation inside `withTenantTransaction`, so RLS scopes every query to the tenant. */
export function createDrizzleCancellationUnitOfWork(db: Database): CancellationUnitOfWork {
  return {
    run: (tenantId, work) =>
      withTenantTransaction(db, tenantId, (tx) => work(createUnit(tx, tenantId))),
  };
}
