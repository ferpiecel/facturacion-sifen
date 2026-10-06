import { and, eq, inArray, isNotNull, notExists, sql } from 'drizzle-orm';
import { documents, loteDocuments, lotes, withTenantTransaction, type Database } from '@sifen/db';
import { enqueueDocumentEvents } from '../../webhooks/infrastructure/enqueue-document-events.js';
import type { ResendPreflightStore } from '../application/resend-preflight.js';
import { IN_PROCESS_LOTE_STATUSES } from './drizzle-lote-assembly-store.js';

export interface DrizzleResendPreflightStoreOptions {
  readonly db: Database;
  readonly tenantId: string;
  readonly now?: () => Date;
}

/** `ResendPreflightStore` over `documents`, run as app_user inside the tenant's transaction. */
export function createDrizzleResendPreflightStore({
  db,
  tenantId,
  now = () => new Date(),
}: DrizzleResendPreflightStoreOptions): ResendPreflightStore {
  return {
    async approveFound(documentId, { messages }) {
      return withTenantTransaction(db, tenantId, async (tx) => {
        const at = now();
        // Only a document the recovery queued again and no lote in process carries: any other
        // state has another path (the poll or the recovery) that owns its outcome.
        const waiting = and(
          eq(documents.id, documentId),
          eq(documents.tenantId, tenantId),
          eq(documents.status, 'queued'),
          isNotNull(documents.resentAt),
          notExists(
            tx
              .select({ one: sql`1` })
              .from(loteDocuments)
              .innerJoin(
                lotes,
                and(eq(lotes.tenantId, loteDocuments.tenantId), eq(lotes.id, loteDocuments.loteId)),
              )
              .where(
                and(
                  eq(loteDocuments.documentId, documents.id),
                  inArray(lotes.status, IN_PROCESS_LOTE_STATUSES),
                ),
              ),
          ),
        );
        const submitted = await tx
          .update(documents)
          .set({ status: 'submitted', updatedAt: at })
          .where(waiting)
          .returning({ id: documents.id });
        if (submitted.length !== 1) return false;
        await enqueueDocumentEvents(tx, { tenantId, documentIds: [documentId], at });
        await tx
          .update(documents)
          .set({ status: 'approved', sifenMessages: messages, updatedAt: at })
          .where(and(eq(documents.id, documentId), eq(documents.status, 'submitted')));
        await enqueueDocumentEvents(tx, { tenantId, documentIds: [documentId], at });
        return true;
      });
    },
  };
}
