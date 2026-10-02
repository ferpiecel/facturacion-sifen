import { and, eq } from 'drizzle-orm';
import { documents, loteDocuments, lotes, withTenantTransaction, type Database } from '@sifen/db';
import type {
  DocumentResolution,
  LotePollGuard,
  LotePollOutcome,
  LotePollStore,
} from '../application/poll-lote-result.js';

export interface DrizzleLotePollStoreOptions {
  readonly db: Database;
  readonly tenantId: string;
}

type Tx = Parameters<Parameters<typeof withTenantTransaction>[2]>[0];

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
              eq(lotes.nextPollAt, guard.expectedNextPollAt),
            ),
          )
          .returning({ id: lotes.id });
        if (updated.length !== 1) return false;
        if (outcome.status === 'processed') {
          for (const resolution of outcome.resolutions) {
            await settleDocument(tx, loteId, resolution, guard.polledAt);
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

/** `submitted -> outcome`; a document already settled the same way is left alone, anything else aborts the transaction. */
async function settleDocument(
  tx: Tx,
  loteId: string,
  { cdc, status, messages }: DocumentResolution,
  at: Date,
): Promise<void> {
  const doc = (
    await tx
      .select({ id: documents.id, status: documents.status })
      .from(documents)
      .innerJoin(
        loteDocuments,
        and(
          eq(loteDocuments.tenantId, documents.tenantId),
          eq(loteDocuments.documentId, documents.id),
        ),
      )
      .where(and(eq(loteDocuments.loteId, loteId), eq(documents.cdc, cdc)))
  ).at(0);
  if (!doc) throw new Error(`Document ${cdc} is not part of lote ${loteId}`);
  if (doc.status === status) return;
  if (doc.status !== 'submitted') {
    throw new Error(`Document ${cdc} is ${doc.status}, expected submitted`);
  }
  await tx
    .update(documents)
    .set({ status, sifenMessages: messages, updatedAt: at })
    .where(and(eq(documents.id, doc.id), eq(documents.status, 'submitted')));
}
