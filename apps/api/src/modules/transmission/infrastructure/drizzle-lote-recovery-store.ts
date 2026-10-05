import { and, eq, sql } from 'drizzle-orm';
import { documents, loteDocuments, lotes, withTenantTransaction, type Database } from '@sifen/db';
import type { LoteRecoveryOutcome, LoteRecoveryStore } from '../application/recover-lote-by-cdc.js';
import { settleDocument } from './settle-document.js';

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
          .where(and(eq(loteDocuments.loteId, loteId), eq(documents.status, 'submitted')));
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
        // Compare-and-set: only the run that still sees the loaded query time wins.
        const updated = await tx
          .update(lotes)
          .set({
            ...columnsFor(outcome),
            lastPolledAt: guard.recoveredAt,
            updatedAt: guard.recoveredAt,
          })
          .where(
            and(
              eq(lotes.id, loteId),
              eq(lotes.status, 'recovery'),
              guard.expectedLastPolledAt === null
                ? sql`${lotes.lastPolledAt} IS NULL`
                : // JS dates carry milliseconds; the column may hold microseconds.
                  sql`date_trunc('milliseconds', ${lotes.lastPolledAt}) = ${guard.expectedLastPolledAt}`,
            ),
          )
          .returning({ id: lotes.id });
        if (updated.length !== 1) return false;
        for (const resolution of outcome.resolutions) {
          await settleDocument(tx, tenantId, loteId, resolution, guard.recoveredAt);
        }
        return true;
      });
    },
  };
}

function columnsFor({ unresolved }: LoteRecoveryOutcome) {
  if (unresolved.length === 0) return { status: 'processed', lastPollMessage: null };
  return {
    status: 'recovery',
    lastPollMessage: `${String(unresolved.length)} document(s) still unresolved by CDC query`,
  };
}
