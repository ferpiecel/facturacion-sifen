import { and, asc, eq, inArray } from 'drizzle-orm';
import { issuerEvents, tenants, withTenantTransaction, type Database } from '@sifen/db';
import type { EventBatchStore, EventOutcome } from '../application/send-event-batch.js';

export interface DrizzleEventBatchStoreOptions {
  readonly db: Database;
  readonly tenantId: string;
  readonly now?: () => Date;
}

const toPending = (row: { id: string; eventId: bigint; signedXml: string | null }) => ({
  id: row.id,
  eventId: row.eventId,
  signedXml: row.signedXml ?? '',
});

/** `EventBatchStore` over `issuer_events`; every call runs as app_user inside the tenant's transaction (ADR-0020). */
export function createDrizzleEventBatchStore({
  db,
  tenantId,
  now = () => new Date(),
}: DrizzleEventBatchStoreOptions): EventBatchStore {
  return {
    async signedEvents(limit) {
      const rows = await withTenantTransaction(db, tenantId, (tx) =>
        tx
          .select({
            id: issuerEvents.id,
            eventId: issuerEvents.eventId,
            signedXml: issuerEvents.signedXml,
          })
          .from(issuerEvents)
          // Only the tenant's current environment: an event of a left one must not be sent.
          .innerJoin(
            tenants,
            and(
              eq(tenants.id, issuerEvents.tenantId),
              eq(tenants.environment, issuerEvents.environment),
            ),
          )
          .where(and(eq(issuerEvents.tenantId, tenantId), eq(issuerEvents.status, 'signed')))
          .orderBy(asc(issuerEvents.createdAt), asc(issuerEvents.id))
          .limit(limit),
      );
      return rows.map(toPending);
    },

    async claim(ids, dId) {
      if (ids.length === 0) return [];
      // One atomic conditional UPDATE: only the worker that flips signed -> sending gets each event.
      const claimed = await withTenantTransaction(db, tenantId, (tx) =>
        tx
          .update(issuerEvents)
          .set({ status: 'sending', batchDId: dId, sendAttemptedAt: now() })
          .where(
            and(
              eq(issuerEvents.tenantId, tenantId),
              inArray(issuerEvents.id, [...ids]),
              eq(issuerEvents.status, 'signed'),
            ),
          )
          .returning({
            id: issuerEvents.id,
            eventId: issuerEvents.eventId,
            signedXml: issuerEvents.signedXml,
          }),
      );
      return claimed.map(toPending);
    },

    async record(outcomes: ReadonlyMap<string, EventOutcome>) {
      await withTenantTransaction(db, tenantId, async (tx) => {
        for (const [id, outcome] of outcomes) {
          const updated = await tx
            .update(issuerEvents)
            .set(
              outcome.status === 'unknown'
                ? { status: 'unknown', responseMessage: outcome.reason }
                : {
                    status: outcome.status,
                    responseCode: outcome.code,
                    responseMessage: outcome.message,
                    respondedAt: now(),
                  },
            )
            .where(
              and(
                eq(issuerEvents.tenantId, tenantId),
                eq(issuerEvents.id, id),
                // `unknown` may still be answered later (ADR-0020).
                inArray(issuerEvents.status, ['sending', 'unknown']),
              ),
            )
            .returning({ id: issuerEvents.id });
          // Throwing rolls the whole transaction back: nothing is settled half way.
          if (updated.length !== 1) throw new Error(`Event ${id} is not being sent`);
        }
      });
    },
  };
}
