import { and, eq, sql } from 'drizzle-orm';
import { documents, loteDocuments, lotes, withTenantTransaction, type Database } from '@sifen/db';
import type {
  LotePollGuard,
  LotePollOutcome,
  LotePollStore,
} from '../application/poll-lote-result.js';
import { settleDocument } from './settle-document.js';

export interface DrizzleLotePollStoreOptions {
  readonly db: Database;
  readonly tenantId: string;
}

/** `LotePollStore` over `lotes`, `lote_documents` and `documents`, run as app_user inside the tenant's transaction. */
export function createDrizzleLotePollStore({
  db,
  tenantId,
}: DrizzleLotePollStoreOptions): LotePollStore {
  return {
    async load(loteId) {
      return withTenantTransaction(db, tenantId, async (tx) => {
        const lote = (await tx.select().from(lotes).where(eq(lotes.id, loteId))).at(0);
        if (!lote) return null;
        const cdcs = await tx
          .select({ cdc: documents.cdc })
          .from(loteDocuments)
          .innerJoin(
            documents,
            and(
              eq(documents.tenantId, loteDocuments.tenantId),
              eq(documents.id, loteDocuments.documentId),
            ),
          )
          .where(eq(loteDocuments.loteId, loteId));
        return {
          loteId: lote.id,
          status: lote.status,
          dProtConsLote: lote.sifenProtocol,
          nextPollAt: lote.nextPollAt,
          pollDeadlineAt: lote.pollDeadlineAt,
          cdcs: cdcs.map((row) => row.cdc),
        };
      });
    },

    async record(loteId, outcome, guard) {
      return withTenantTransaction(db, tenantId, async (tx) => {
        // Compare-and-set: only the poll that still sees the loaded schedule wins.
        const updated = await tx
          .update(lotes)
          .set({ ...columnsFor(outcome, guard), updatedAt: guard.polledAt })
          .where(
            and(
              eq(lotes.id, loteId),
              eq(lotes.status, 'sent'),
              // JS dates carry milliseconds; the column may hold microseconds.
              sql`date_trunc('milliseconds', ${lotes.nextPollAt}) = ${guard.expectedNextPollAt}`,
            ),
          )
          .returning({ id: lotes.id });
        if (updated.length !== 1) return false;
        if (outcome.status === 'processed') {
          for (const resolution of outcome.resolutions) {
            await settleDocument(tx, tenantId, loteId, resolution, guard.polledAt);
          }
        }
        return true;
      });
    },
  };
}

function columnsFor(outcome: LotePollOutcome, { polledAt }: LotePollGuard) {
  switch (outcome.status) {
    case 'pending':
      return {
        nextPollAt: outcome.nextPollAt,
        lastPolledAt: polledAt,
        lastPollMessage: outcome.reason,
      };
    case 'processed':
      return {
        status: 'processed',
        nextPollAt: null,
        lastPolledAt: polledAt,
        lastPollMessage:
          outcome.needsRecovery.length > 0
            ? `${String(outcome.needsRecovery.length)} document(s) need recovery`
            : null,
      };
    case 'recovery':
      return {
        status: 'recovery',
        nextPollAt: null,
        lastPolledAt: polledAt,
        lastPollMessage: outcome.reason,
      };
  }
}
