import { and, asc, eq, inArray, lt } from 'drizzle-orm';
import { documents, issuerEvents, tenants, withTenantTransaction, type Database } from '@sifen/db';
import type {
  EventRecoveryStore,
  UnresolvedCancellation,
} from '../application/resolve-unknown-events.js';
import { createDrizzleEventBatchStore } from './drizzle-event-batch-store.js';

export interface DrizzleEventRecoveryStoreOptions {
  readonly db: Database;
  readonly tenantId: string;
  readonly now?: () => Date;
}

/** `EventRecoveryStore` over `issuer_events`, as app_user inside the tenant's transaction (ADR-0020). */
export function createDrizzleEventRecoveryStore({
  db,
  tenantId,
  now,
}: DrizzleEventRecoveryStoreOptions): EventRecoveryStore {
  const batch = createDrizzleEventBatchStore({ db, tenantId, now });
  return {
    record: (outcomes) => batch.record(outcomes),

    async sweepStaleSending(cutoff, limit) {
      // One conditional UPDATE: only a row still `sending` and attempted before the cutoff moves.
      const swept = await withTenantTransaction(db, tenantId, async (tx) => {
        const stale = tx
          .select({ id: issuerEvents.id })
          .from(issuerEvents)
          .where(
            and(
              eq(issuerEvents.tenantId, tenantId),
              eq(issuerEvents.status, 'sending'),
              lt(issuerEvents.sendAttemptedAt, cutoff),
            ),
          )
          .orderBy(asc(issuerEvents.sendAttemptedAt), asc(issuerEvents.id))
          .limit(limit);
        return tx
          .update(issuerEvents)
          .set({ status: 'unknown', responseMessage: 'The send got no recorded outcome' })
          .where(and(eq(issuerEvents.status, 'sending'), inArray(issuerEvents.id, stale)))
          .returning({ id: issuerEvents.id });
      });
      return swept.length;
    },

    async unresolvedCancellations(sentBefore, limit) {
      const rows = await withTenantTransaction(db, tenantId, (tx) =>
        tx
          .select({ id: issuerEvents.id, cdc: documents.cdc })
          .from(issuerEvents)
          .innerJoin(
            documents,
            and(
              eq(documents.tenantId, issuerEvents.tenantId),
              eq(documents.id, issuerEvents.documentId),
            ),
          )
          .innerJoin(
            tenants,
            and(
              eq(tenants.id, issuerEvents.tenantId),
              eq(tenants.environment, issuerEvents.environment),
            ),
          )
          .where(
            and(
              eq(issuerEvents.tenantId, tenantId),
              eq(issuerEvents.status, 'unknown'),
              eq(issuerEvents.kind, 'cancellation'),
              lt(issuerEvents.sendAttemptedAt, sentBefore),
            ),
          )
          .orderBy(asc(issuerEvents.updatedAt), asc(issuerEvents.id))
          .limit(limit),
      );
      return rows.map((row): UnresolvedCancellation => ({ id: row.id, cdc: row.cdc }));
    },

    async noteInconclusive(id, note) {
      await withTenantTransaction(db, tenantId, (tx) =>
        tx
          .update(issuerEvents)
          .set({ responseMessage: note.slice(0, 500) })
          .where(
            and(
              eq(issuerEvents.tenantId, tenantId),
              eq(issuerEvents.id, id),
              eq(issuerEvents.status, 'unknown'),
            ),
          ),
      );
    },
  };
}
