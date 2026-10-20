import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { documents, issuerEvents, tenants, withTenantTransaction, type Database } from '@sifen/db';
import { recordAudit } from '../../audit/infrastructure/record-audit.js';
import { enqueueDocumentEvents } from '../../webhooks/infrastructure/enqueue-document-events.js';
import type { EventBatchStore, EventOutcome } from '../application/send-event-batch.js';
import { TRANSMISSION_WORKER_ACTOR } from './transmission-audit-actor.js';
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

type Tx = Parameters<Parameters<typeof withTenantTransaction>[2]>[0];

/** One audit row per settled event (ADR-0020): ids and codes only, never the XML. */
async function auditEvent(tx: Tx, id: string, status: string, code: string | null): Promise<void> {
  await recordAudit(tx, {
    actor: TRANSMISSION_WORKER_ACTOR,
    action: `issuer_event.${status}`,
    entity: { type: 'issuer_event', id },
    before: null,
    after: { status, responseCode: code },
  });
}

/**
 * SIFEN registered the cancellation: an approved document becomes `cancelled`, with its webhook queued in
 * the same transaction. A document in any other state (already cancelled, a late approval race) is left
 * alone: the event is settled either way.
 */
async function cancelDocument(
  tx: Tx,
  tenantId: string,
  documentId: string,
  at: Date,
): Promise<void> {
  const cancelled = await tx
    .update(documents)
    .set({ status: 'cancelled', updatedAt: at })
    .where(
      and(
        eq(documents.tenantId, tenantId),
        eq(documents.id, documentId),
        inArray(documents.status, ['approved', 'approved_with_observations']),
      ),
    )
    .returning({ id: documents.id })
    .then((rows) => rows.at(0));
  if (!cancelled) return;
  await recordAudit(tx, {
    actor: TRANSMISSION_WORKER_ACTOR,
    action: 'document.cancelled',
    entity: { type: 'document', id: documentId },
    before: null,
    after: { status: 'cancelled' },
  });
  await enqueueDocumentEvents(tx, { tenantId, documentIds: [documentId], at });
}

/** `EventBatchStore` over `issuer_events`, as app_user inside the tenant's transaction (ADR-0020). */
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
      const claimed = await withTenantTransaction(db, tenantId, (tx) =>
        tx
          .update(issuerEvents)
          .set({ status: 'sending', batchDId: dId, sendAttemptedAt: now() })
          .where(
            and(
              eq(issuerEvents.tenantId, tenantId),
              inArray(issuerEvents.id, [...ids]),
              eq(issuerEvents.status, 'signed'),
              sql`exists (select 1 from ${tenants} where ${tenants.id} = ${issuerEvents.tenantId} and ${tenants.environment} = ${issuerEvents.environment})`,
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

    async rejectUnsent(rejections) {
      await withTenantTransaction(db, tenantId, async (tx) => {
        for (const [id, rejection] of rejections) {
          const updated = await tx
            .update(issuerEvents)
            .set({
              status: 'rejected',
              responseCode: rejection.code,
              responseMessage: rejection.message,
              respondedAt: now(),
            })
            .where(
              and(
                eq(issuerEvents.tenantId, tenantId),
                eq(issuerEvents.id, id),
                eq(issuerEvents.status, 'signed'),
              ),
            )
            .returning({ id: issuerEvents.id });
          if (updated.length !== 1) throw new Error(`Event ${id} is not waiting to be sent`);
          await auditEvent(tx, id, 'rejected', rejection.code);
        }
      });
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
                inArray(issuerEvents.status, ['sending', 'unknown']),
              ),
            )
            .returning({
              id: issuerEvents.id,
              kind: issuerEvents.kind,
              documentId: issuerEvents.documentId,
            });
          if (updated.length !== 1) throw new Error(`Event ${id} is not being sent`);
          await auditEvent(
            tx,
            id,
            outcome.status,
            outcome.status === 'unknown' ? null : outcome.code,
          );
          const [event] = updated;
          if (outcome.status === 'approved' && event.kind === 'cancellation' && event.documentId) {
            await cancelDocument(tx, tenantId, event.documentId, now());
          }
        }
      });
    },
  };
}
