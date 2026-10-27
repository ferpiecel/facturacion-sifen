import { and, eq, sql } from 'drizzle-orm';
import {
  documentCorrections,
  documents,
  tenantEstablishments,
  tenantExpeditionPoints,
  withTenantTransaction,
  type Database,
} from '@sifen/db';
import { recordAudit } from '../../audit/infrastructure/record-audit.js';
import { IdempotencyKeyCollisionError } from '../application/ports/acceptance-unit-of-work.port.js';
import type {
  CorrectionUnit,
  CorrectionUnitOfWork,
} from '../application/ports/correction-unit-of-work.port.js';
import { createAcceptanceUnit, isIdempotencyCollision } from './drizzle-acceptance-unit-of-work.js';

/** Runs the correction inside `withTenantTransaction`, so RLS scopes every query to the tenant. */
export function createDrizzleCorrectionUnitOfWork(db: Database): CorrectionUnitOfWork {
  return {
    run: (tenantId, work) =>
      withTenantTransaction(db, tenantId, (tx) => {
        const acceptance = createAcceptanceUnit(tx, tenantId);
        const unit: CorrectionUnit = {
          resolveIssuer: (query) => acceptance.resolveIssuer(query),
          findAssociatedInvoice: (cdc, env) => acceptance.findAssociatedInvoice(cdc, env),
          sumCreditNotes: (cdc, env, exclude) => acceptance.sumCreditNotes(cdc, env, exclude),
          recordAudit: (entry) => recordAudit(tx, entry),
          async findCorrectionByKey(key) {
            const rows = await tx
              .select({
                documentId: documentCorrections.documentId,
                cdc: documents.cdc,
                requestHash: documentCorrections.requestHash,
              })
              .from(documentCorrections)
              .innerJoin(
                documents,
                and(
                  eq(documents.tenantId, documentCorrections.tenantId),
                  eq(documents.id, documentCorrections.documentId),
                ),
              )
              .where(
                and(
                  eq(documentCorrections.tenantId, tenantId),
                  eq(documentCorrections.idempotencyKey, key),
                ),
              );
            return rows.at(0) ?? null;
          },
          async lockDocument(documentId) {
            const rows = await tx
              .select({
                id: documents.id,
                cdc: documents.cdc,
                documentType: documents.documentType,
                status: documents.status,
                establishmentCode: tenantEstablishments.code,
                expeditionPointCode: tenantExpeditionPoints.code,
                associatedCdc: documents.associatedCdc,
                payload: documents.payload,
                sifenMessages: documents.sifenMessages,
              })
              .from(documents)
              .innerJoin(
                tenantExpeditionPoints,
                and(
                  eq(tenantExpeditionPoints.tenantId, documents.tenantId),
                  eq(tenantExpeditionPoints.id, documents.expeditionPointId),
                ),
              )
              .innerJoin(
                tenantEstablishments,
                and(
                  eq(tenantEstablishments.tenantId, documents.tenantId),
                  eq(tenantEstablishments.id, documents.establishmentId),
                ),
              )
              .where(and(eq(documents.tenantId, tenantId), eq(documents.id, documentId)))
              .for('update', { of: documents });
            return rows.at(0) ?? null;
          },
          async rewriteDocument(change) {
            try {
              // The guard door requires the history row to exist first (ADR-0021 D1).
              await tx.insert(documentCorrections).values({
                tenantId,
                documentId: change.document.id,
                kind: 'same_cdc',
                idempotencyKey: change.idempotencyKey,
                requestHash: change.requestHash,
                previousPayload: change.document.payload,
                previousSifenMessages: change.document.sifenMessages,
              });
            } catch (error) {
              if (isIdempotencyCollision(error)) throw new IdempotencyKeyCollisionError();
              throw error;
            }
            await tx
              .update(documents)
              .set({
                status: 'accepted',
                correctionsCount: sql`${documents.correctionsCount} + 1`,
                payload: change.payload,
                receiverRuc: change.receiverRuc,
                totalAmount: change.totalAmount,
                signedXml: null,
                signedAt: null,
                transmissionAttempts: 0,
                transmissionHold: null,
                nextTransmissionAt: null,
                sifenMessages: null,
              })
              .where(and(eq(documents.tenantId, tenantId), eq(documents.id, change.document.id)));
          },
        };
        return work(unit);
      }),
  };
}
