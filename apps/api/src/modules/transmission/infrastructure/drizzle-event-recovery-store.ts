import { and, asc, eq, inArray, isNull, lt, lte, ne, or, sql } from 'drizzle-orm';
import { documents, issuerEvents, tenants, withTenantTransaction, type Database } from '@sifen/db';
import {
  ABSENCE_NOTED_CODE,
  OPERATOR_HOLD_CODE,
  type EventRecoveryStore,
  type UnresolvedCancellation,
} from '../application/resolve-unknown-events.js';
import { createDrizzleEventBatchStore } from './drizzle-event-batch-store.js';

export interface DrizzleEventRecoveryStoreOptions {
  readonly db: Database;
  readonly tenantId: string;
  readonly now?: () => Date;
  /**
   * How long a claimed event stays out of other workers' lists (default 5 minutes). The claim is the
   * `updated_at` touch inside the same transaction that locks the rows with `FOR UPDATE SKIP LOCKED`.
   */
  readonly claimLeaseMs?: number;
}

/** `EventRecoveryStore` over `issuer_events`, as app_user inside the tenant's transaction (ADR-0020). */
export function createDrizzleEventRecoveryStore({
  db,
  tenantId,
  now,
  claimLeaseMs = 5 * 60_000,
}: DrizzleEventRecoveryStoreOptions): EventRecoveryStore {
  const clock = now ?? (() => new Date());
  const batch = createDrizzleEventBatchStore({ db, tenantId, now });
  /** A `LOC-` marker on an event that stays `unknown`; the answered pair needs the time with the code. */
  const markUnknown = (id: string, code: string, note: string): Promise<void> =>
    withTenantTransaction(db, tenantId, async (tx) => {
      await tx
        .update(issuerEvents)
        .set({ responseCode: code, respondedAt: clock(), responseMessage: note.slice(0, 500) })
        .where(
          and(
            eq(issuerEvents.tenantId, tenantId),
            eq(issuerEvents.id, id),
            eq(issuerEvents.status, 'unknown'),
          ),
        );
    });
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
      return withTenantTransaction(db, tenantId, async (tx) => {
        const rows = await tx
          .select({
            id: issuerEvents.id,
            kind: issuerEvents.kind,
            cdc: documents.cdc,
            sentAt: issuerEvents.sendAttemptedAt,
            responseCode: issuerEvents.responseCode,
            respondedAt: issuerEvents.respondedAt,
          })
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
              inArray(issuerEvents.kind, ['cancellation', 'nomination']),
              lt(issuerEvents.sendAttemptedAt, sentBefore),
              or(
                isNull(issuerEvents.responseCode),
                ne(issuerEvents.responseCode, OPERATOR_HOLD_CODE),
              ),
              lte(issuerEvents.updatedAt, sql`now() - ${claimLeaseMs} * interval '1 millisecond'`),
            ),
          )
          .orderBy(asc(issuerEvents.updatedAt), asc(issuerEvents.id))
          .limit(limit)
          // Only the events' own rows: a concurrent worker skips what this one has locked.
          .for('update', { of: issuerEvents, skipLocked: true });
        if (rows.length > 0) {
          // The claim outlives the transaction: the touch moves the rows out of the others' lists.
          await tx
            .update(issuerEvents)
            .set({ updatedAt: sql`now()` })
            .where(
              and(
                eq(issuerEvents.status, 'unknown'),
                inArray(
                  issuerEvents.id,
                  rows.map((row) => row.id),
                ),
              ),
            );
        }
        return rows.map((row): UnresolvedCancellation => ({
          id: row.id,
          kind: row.kind === 'nomination' ? 'nomination' : 'cancellation',
          cdc: row.cdc,
          sentAt: row.sentAt ?? sentBefore,
          missedAt: row.responseCode === ABSENCE_NOTED_CODE ? row.respondedAt : null,
        }));
      });
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

    noteMissing: (id, note) => markUnknown(id, ABSENCE_NOTED_CODE, note),

    hold: (id, note) => markUnknown(id, OPERATOR_HOLD_CODE, note),
  };
}
