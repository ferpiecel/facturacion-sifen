import { and, eq } from 'drizzle-orm';
import { webhookDeliveries, webhookEndpoints, type TenantTx } from '@sifen/db';
import {
  deadlineWarningData,
  deadlineWarningEventId,
  type DeadlineWarningSource,
} from '../domain/webhook-document-events.js';
import { createWebhookEvent, matchesEventFilter } from '../domain/webhook-event.js';

const TYPE = 'document.transmission_deadline_warning';

/**
 * HU-E6-07: outbox rows for the deadline warnings, one per active matching endpoint. The event id is
 * deterministic per (document, threshold), so UNIQUE(endpoint_id, event_id) makes a repeated run, a
 * restart or a concurrent worker a no-op instead of a duplicate warning.
 */
export async function enqueueDeadlineWarnings(
  tx: TenantTx,
  {
    tenantId,
    warnings,
    at,
  }: { tenantId: string; warnings: readonly DeadlineWarningSource[]; at: Date },
): Promise<void> {
  if (warnings.length === 0) return;
  const endpoints = await tx
    .select({ id: webhookEndpoints.id, events: webhookEndpoints.events })
    .from(webhookEndpoints)
    .where(and(eq(webhookEndpoints.tenantId, tenantId), eq(webhookEndpoints.active, true)));
  const rows: (typeof webhookDeliveries.$inferInsert)[] = [];
  for (const warning of warnings) {
    const eventId = deadlineWarningEventId(warning.documentId, warning.thresholdHours);
    const payload = createWebhookEvent({
      id: eventId,
      type: TYPE,
      createdAt: at,
      tenantId,
      data: deadlineWarningData(warning),
    });
    for (const endpoint of endpoints) {
      if (!matchesEventFilter(endpoint.events, TYPE)) continue;
      rows.push({
        tenantId,
        endpointId: endpoint.id,
        eventId,
        eventType: TYPE,
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
