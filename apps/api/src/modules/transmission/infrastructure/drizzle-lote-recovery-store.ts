import { and, eq, inArray, sql } from 'drizzle-orm';
import { documents, loteDocuments, lotes, withTenantTransaction, type Database } from '@sifen/db';
import type { LoteRecoveryOutcome, LoteRecoveryStore } from '../application/recover-lote-by-cdc.js';
import { enqueueDocumentEvents } from '../../webhooks/infrastructure/enqueue-document-events.js';
import { settleDocument, type Tx } from './settle-document.js';

export interface DrizzleLoteRecoveryStoreOptions {
  readonly db: Database;
  readonly tenantId: string;
}

/** `LoteRecoveryStore` over `lotes`, `lote_documents` and `documents`, run as app_user inside the tenant's transaction. */
export function createDrizzleLoteRecoveryStore({
  db,
  tenantId,
}: DrizzleLoteRecoveryStoreOptions): LoteRecoveryStore {
  return {
    async load(loteId) {
      return withTenantTransaction(db, tenantId, async (tx) => {
        const lote = (await tx.select().from(lotes).where(eq(lotes.id, loteId))).at(0);
        if (!lote) return null;
        const pending = await tx
          .select({ cdc: documents.cdc })
          .from(loteDocuments)
          .innerJoin(
            documents,
            and(
              eq(documents.tenantId, loteDocuments.tenantId),
              eq(documents.id, loteDocuments.documentId),
            ),
          )
          .where(
            and(
              eq(loteDocuments.loteId, loteId),
              // An unknown lote never got a confirmed send: its documents are still queued.
              eq(documents.status, lote.status === 'unknown' ? 'queued' : 'submitted'),
            ),
          );
        return {
          loteId: lote.id,
          status: lote.status,
          lastPolledAt: lote.lastPolledAt,
          cdcs: pending.map((row) => row.cdc),
        };
      });
    },

    async record(loteId, outcome, guard) {
      return withTenantTransaction(db, tenantId, async (tx) => {
        const current = (
          await tx
            .select({ message: lotes.lastPollMessage })
            .from(lotes)
            .where(eq(lotes.id, loteId))
        ).at(0);
        // Compare-and-set: only the run that still sees the loaded status and query time wins.
        const updated = await tx
          .update(lotes)
          .set({
            ...columnsFor(outcome, current?.message ?? null),
            lastPolledAt: guard.recoveredAt,
            updatedAt: guard.recoveredAt,
          })
          .where(
            and(
              eq(lotes.id, loteId),
              eq(lotes.status, guard.expectedStatus),
              guard.expectedLastPolledAt === null
                ? sql`${lotes.lastPolledAt} IS NULL`
                : // JS dates carry milliseconds; the column may hold microseconds.
                  sql`date_trunc('milliseconds', ${lotes.lastPolledAt}) = ${guard.expectedLastPolledAt}`,
            ),
          )
          .returning({ id: lotes.id });
        if (updated.length !== 1) return false;
        for (const resolution of outcome.resolutions) {
          if (guard.expectedStatus === 'unknown') {
            await confirmSubmitted(tx, tenantId, loteId, resolution.cdc, guard.recoveredAt);
          }
          await settleDocument(tx, tenantId, loteId, resolution, guard.recoveredAt);
        }
        return true;
      });
    },
  };
}

/** Marks the start of the recovery's own text in `last_poll_message`; what precedes it is the hand-over reason. */
const RECOVERY_NOTE = ' | recovery: ';

/** The hand-over reason (0364, window elapsed...) is kept; only the recovery note after it is rewritten. */
function columnsFor({ unresolved }: LoteRecoveryOutcome, previous: string | null) {
  const reason = (previous ?? '').split(RECOVERY_NOTE)[0].replace(/^recovery: .*/, '') || null;
  if (unresolved.length === 0) return { status: 'processed', lastPollMessage: reason };
  const note = `${String(unresolved.length)} document(s) still unresolved by CDC query`;
  return {
    lastPollMessage: reason === null ? `recovery: ${note}` : `${reason}${RECOVERY_NOTE}${note}`,
  };
}

/**
 * SIFEN answered for a document of an unanswered send: the lote did reach it, so the document goes
 * `queued -> submitted` (and says so) just before it is approved.
 */
async function confirmSubmitted(
  tx: Tx,
  tenantId: string,
  loteId: string,
  cdc: string,
  at: Date,
): Promise<void> {
  const confirmed = await tx
    .update(documents)
    .set({ status: 'submitted', updatedAt: at })
    .where(
      and(
        eq(documents.cdc, cdc),
        eq(documents.status, 'queued'),
        inArray(
          documents.id,
          tx
            .select({ id: loteDocuments.documentId })
            .from(loteDocuments)
            .where(eq(loteDocuments.loteId, loteId)),
        ),
      ),
    )
    .returning({ id: documents.id });
  await enqueueDocumentEvents(tx, { tenantId, documentIds: confirmed.map((row) => row.id), at });
}
