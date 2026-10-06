import { and, eq, inArray, isNotNull, notExists, sql } from 'drizzle-orm';
import { documents, loteDocuments, lotes, withTenantTransaction, type Database } from '@sifen/db';
import { enqueueDocumentEvents } from '../../webhooks/infrastructure/enqueue-document-events.js';
import type { ResendPreflightStore } from '../application/resend-preflight.js';
import { recordAudit } from '../../audit/infrastructure/record-audit.js';
import { IN_PROCESS_LOTE_STATUSES, stillCarries } from './drizzle-lote-assembly-store.js';
import { TRANSMISSION_WORKER_ACTOR } from './transmission-audit-actor.js';

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
        // Wait for the row first, in a statement of its own: `createLote` locks its documents FOR
        // UPDATE, and only after that lock is granted does the check below (a fresh snapshot) see the
        // lote it just created. A single UPDATE ... WHERE NOT EXISTS would decide on the old snapshot.
        const locked = await tx
          .select({ id: documents.id })
          .from(documents)
          .where(and(eq(documents.id, documentId), eq(documents.tenantId, tenantId)))
          .for('update');
        if (locked.length !== 1) return false;
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
                  stillCarries,
                ),
              ),
          ),
        );
        const eligible = await tx.select({ id: documents.id }).from(documents).where(waiting);
        if (eligible.length !== 1) return false;
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
        await recordAudit(tx, {
          actor: TRANSMISSION_WORKER_ACTOR,
          action: 'document.approved_on_resend_check',
          entity: { type: 'document', id: documentId },
          before: { status: 'queued' },
          after: { status: 'approved' },
        });
        return true;
      });
    },
  };
}
