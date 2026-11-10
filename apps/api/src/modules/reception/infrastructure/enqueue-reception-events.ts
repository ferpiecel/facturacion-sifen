import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { webhookDeliveries, webhookEndpoints, type TenantTx } from '@sifen/db';
import { createWebhookEvent, matchesEventFilter } from '../../webhooks/domain/webhook-event.js';
import type { ReceivedDocument } from '../domain/received-document.js';
import type { ReceptionActor, ReceptionEventType } from '../domain/reception-events.js';

export interface EnqueueReceptionEventsInput {
  readonly tenantId: string;
  /** The aggregate AS WRITTEN by the caller's transaction (post-change status and version). */
  readonly document: ReceivedDocument;
  readonly types: readonly ReceptionEventType[];
  /** Required content of `reception.document.updated`; ignored by the other events. */
  readonly actor?: ReceptionActor;
  /** The transition time; also when the deliveries become due. */
  readonly at: Date;
}

/**
 * Deterministic per (document, type, version): a retried transition never enqueues twice (with
 * UNIQUE(endpoint_id, event_id)), while each later edit of a confirmed document is a new event.
 */
export function receptionEventId(
  documentId: string,
  type: ReceptionEventType,
  version: number,
): string {
  return `evt_${createHash('sha256')
    .update(`reception:${documentId}:${type}:${String(version)}`)
    .digest('hex')
    .slice(0, 32)}`;
}

function eventData(
  document: ReceivedDocument,
  type: ReceptionEventType,
  actor: ReceptionActor | undefined,
): Record<string, unknown> {
  // Identifiers, status and a link only (ADR-0023): never extracted fiscal data.
  const data: Record<string, unknown> = {
    document_id: document.id,
    status: document.status,
    version: document.version,
    links: { self: `/v1/received-documents/${document.id}` },
  };
  if (type === 'reception.document.needs_review') {
    data.reasons = [...document.needsReviewReasons];
  }
  if (type === 'reception.document.updated') {
    const who = actor ?? { kind: 'system' as const };
    data.actor = who.kind === 'api_key' ? { type: 'api_key', id: who.id } : { type: who.kind };
  }
  return data;
}

/**
 * Transactional outbox for received-document events (ADR-0023, mirrors `enqueueDocumentEvents`):
 * call it with the writer's own transaction so the state change and its deliveries commit or roll
 * back together. One `pending` delivery, due at `at`, per active endpoint of the tenant whose
 * filter matches. A document that is not addressed to the tenant (`isOwnReceiver = false`, Q3)
 * enqueues nothing, whatever the event type.
 */
export async function enqueueReceptionEvents(
  tx: TenantTx,
  { tenantId, document, types, actor, at }: EnqueueReceptionEventsInput,
): Promise<void> {
  if (types.length === 0 || !document.isOwnReceiver) return;
  const endpoints = await tx
    .select({ id: webhookEndpoints.id, events: webhookEndpoints.events })
    .from(webhookEndpoints)
    .where(and(eq(webhookEndpoints.tenantId, tenantId), eq(webhookEndpoints.active, true)));
  const rows: (typeof webhookDeliveries.$inferInsert)[] = [];
  for (const type of types) {
    const eventId = receptionEventId(document.id, type, document.version);
    const payload = createWebhookEvent({
      id: eventId,
      type,
      createdAt: at,
      tenantId,
      data: eventData(document, type, actor),
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
