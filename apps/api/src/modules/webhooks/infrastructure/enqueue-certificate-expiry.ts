import { and, eq } from 'drizzle-orm';
import { webhookDeliveries, webhookEndpoints, type TenantTx } from '@sifen/db';
import {
  certificateExpiryData,
  certificateExpiryEventId,
  type CertificateExpirySource,
} from '../domain/webhook-certificate-events.js';
import { createWebhookEvent, matchesEventFilter } from '../domain/webhook-event.js';

const TYPE = 'certificate.expiring';

/**
 * HU-E3-03: outbox rows for the certificate expiry alerts, one per active matching endpoint. The event
 * id is deterministic per (certificate, threshold), so UNIQUE(endpoint_id, event_id) makes a repeated
 * run, a restart or a concurrent worker a no-op instead of a duplicate alert.
 */
export async function enqueueCertificateExpiry(
  tx: TenantTx,
  {
    tenantId,
    alerts,
    at,
  }: { tenantId: string; alerts: readonly CertificateExpirySource[]; at: Date },
): Promise<void> {
  if (alerts.length === 0) return;
  const endpoints = await tx
    .select({ id: webhookEndpoints.id, events: webhookEndpoints.events })
    .from(webhookEndpoints)
    .where(and(eq(webhookEndpoints.tenantId, tenantId), eq(webhookEndpoints.active, true)));
  const rows: (typeof webhookDeliveries.$inferInsert)[] = [];
  for (const alert of alerts) {
    const eventId = certificateExpiryEventId(alert.certificateId, alert.thresholdDays);
    const payload = createWebhookEvent({
      id: eventId,
      type: TYPE,
      createdAt: at,
      tenantId,
      data: certificateExpiryData(alert),
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
