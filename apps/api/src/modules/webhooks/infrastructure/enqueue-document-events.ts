import { and, eq, inArray } from 'drizzle-orm';
import { documents, webhookDeliveries, webhookEndpoints, type TenantTx } from '@sifen/db';
import {
  documentEventData,
  documentEventId,
  eventTypeForDocumentStatus,
} from '../domain/webhook-document-events.js';
import { createWebhookEvent, matchesEventFilter } from '../domain/webhook-event.js';

export interface EnqueueDocumentEventsInput {
  readonly tenantId: string;
  /** Documents whose status was JUST changed by the caller, inside this same transaction. */
  readonly documentIds: readonly string[];
  /** The transition time; also when the deliveries become due. */
  readonly at: Date;
}

/**
 * Transactional outbox (HU-E11-01): call it from every adapter that changes a document's status, with
 * the adapter's own transaction, so the status change and its webhook deliveries commit or roll back
 * together. Reads each document's current status, and enqueues one `pending` delivery, due at `at`,
 * for every active endpoint of the tenant whose filter matches. Idempotent through the deterministic
 * event id and UNIQUE(endpoint_id, event_id).
 */
export async function enqueueDocumentEvents(
  tx: TenantTx,
  { tenantId, documentIds, at }: EnqueueDocumentEventsInput,
): Promise<void> {
  if (documentIds.length === 0) return;
  const endpoints = await tx
    .select({ id: webhookEndpoints.id, events: webhookEndpoints.events })
    .from(webhookEndpoints)
    .where(and(eq(webhookEndpoints.tenantId, tenantId), eq(webhookEndpoints.active, true)));
  if (endpoints.length === 0) return;
  const docs = await tx
    .select({
      id: documents.id,
      cdc: documents.cdc,
      documentType: documents.documentType,
      status: documents.status,
      sifenMessages: documents.sifenMessages,
    })
    .from(documents)
    .where(and(eq(documents.tenantId, tenantId), inArray(documents.id, [...documentIds])));
  const rows: (typeof webhookDeliveries.$inferInsert)[] = [];
  for (const doc of docs) {
    const type = eventTypeForDocumentStatus(doc.status);
    if (type === undefined) continue;
    const eventId = documentEventId(doc.id, type);
    const payload = createWebhookEvent({
      id: eventId,
      type,
      createdAt: at,
      tenantId,
      data: documentEventData(doc),
    });
    for (const endpoint of endpoints) {
      if (!matchesEventFilter(endpoint.events, type)) continue;
      rows.push({
        tenantId,
        endpointId: endpoint.id,
        eventId,
        eventType: type,
        payload,
        nextAttemptAt: at,
      });
    }
  }
  if (rows.length === 0) return;
  await tx
    .insert(webhookDeliveries)
    .values(rows)
    .onConflictDoNothing({ target: [webhookDeliveries.endpointId, webhookDeliveries.eventId] });
}
