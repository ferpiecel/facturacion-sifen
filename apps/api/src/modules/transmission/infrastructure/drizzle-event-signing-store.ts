import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { documents, issuerEvents, tenants, withTenantTransaction, type Database } from '@sifen/db';
import type {
  EventSigningStore,
  EventToSign,
  StoredReceiverData,
  StoredVoidRange,
} from '../application/sign-pending-event.js';

export interface DrizzleEventSigningStoreOptions {
  readonly db: Database;
  readonly tenantId: string;
}

/** `EventSigningStore` over `issuer_events`, as app_user inside the tenant's transaction (ADR-0020). */
export function createDrizzleEventSigningStore({
  db,
  tenantId,
}: DrizzleEventSigningStoreOptions): EventSigningStore {
  return {
    async pendingEventIds(limit) {
      const rows = await withTenantTransaction(db, tenantId, (tx) =>
        tx
          .select({ id: issuerEvents.id })
          .from(issuerEvents)
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
              eq(issuerEvents.status, 'pending'),
              isNull(issuerEvents.responseMessage),
            ),
          )
          .orderBy(asc(issuerEvents.createdAt), asc(issuerEvents.id))
          .limit(limit),
      );
      return rows.map((row) => row.id);
    },

    async holdEvent(eventId, reason) {
      await withTenantTransaction(db, tenantId, (tx) =>
        tx
          .update(issuerEvents)
          // A pending event cannot carry a response code (issuer_events_answered_pair): the reason in
          // `response_message`, empty on every pending event, is the marker `pendingEventIds` skips.
          .set({ responseMessage: reason.slice(0, 500) })
          .where(
            and(
              eq(issuerEvents.tenantId, tenantId),
              eq(issuerEvents.id, eventId),
              eq(issuerEvents.status, 'pending'),
            ),
          ),
      );
    },

    async load(eventId) {
      const row = await withTenantTransaction(db, tenantId, (tx) =>
        tx
          .select({
            id: issuerEvents.id,
            status: issuerEvents.status,
            environment: issuerEvents.environment,
            tenantEnvironment: tenants.environment,
            eventId: issuerEvents.eventId,
            kind: issuerEvents.kind,
            reason: issuerEvents.reason,
            cdc: sql<string | null>`coalesce(${documents.cdc}, ${issuerEvents.targetCdc})`,
            voidRange: issuerEvents.voidRange,
            receiverData: issuerEvents.receiverData,
          })
          .from(issuerEvents)
          .innerJoin(tenants, eq(tenants.id, issuerEvents.tenantId))
          .leftJoin(
            documents,
            and(
              eq(documents.tenantId, issuerEvents.tenantId),
              eq(documents.id, issuerEvents.documentId),
            ),
          )
          .where(and(eq(issuerEvents.tenantId, tenantId), eq(issuerEvents.id, eventId)))
          .then((rows) => rows.at(0)),
      );
      if (!row) return undefined;
      const event: EventToSign = {
        ...row,
        voidRange: row.voidRange as StoredVoidRange | null,
        receiverData: row.receiverData as StoredReceiverData | null,
      };
      return event;
    },

    async markSigned(eventId, { signedXml, signedAt }) {
      const updated = await withTenantTransaction(db, tenantId, (tx) =>
        tx
          .update(issuerEvents)
          .set({ status: 'signed', signedXml, signedAt })
          .where(
            and(
              eq(issuerEvents.tenantId, tenantId),
              eq(issuerEvents.id, eventId),
              eq(issuerEvents.status, 'pending'),
            ),
          )
          .returning({ id: issuerEvents.id }),
      );
      return updated.length === 1;
    },
  };
}
