import { and, desc, eq, sql } from 'drizzle-orm';
import { webhookDeliveries, withTenantTransaction, type Database } from '@sifen/db';
import { recordAudit } from '../../audit/infrastructure/record-audit.js';
import type {
  DeliveryView,
  WebhookDeliveryAdminStore,
} from '../application/ports/webhook-delivery-admin-store.port.js';

type Row = typeof webhookDeliveries.$inferSelect;

/** Everything but the payload: the history never echoes event bodies back. */
const toView = (row: Row): DeliveryView => ({
  id: row.id,
  endpointId: row.endpointId,
  eventId: row.eventId,
  eventType: row.eventType,
  status: row.status,
  attemptCount: row.attemptCount,
  lastStatusCode: row.lastStatusCode,
  lastError: row.lastError,
  nextAttemptAt: row.nextAttemptAt,
  deliveredAt: row.deliveredAt,
  createdAt: row.createdAt,
});

const audited = (row: Row) => ({ status: row.status, attempt_count: row.attemptCount });

/** `WebhookDeliveryAdminStore` over `webhook_deliveries`: app_user inside the tenant's transaction. */
export function createDrizzleWebhookDeliveryAdminStore(db: Database): WebhookDeliveryAdminStore {
  return {
    async list(tenantId, { endpointId, status, limit, after }) {
      const rows = await withTenantTransaction(db, tenantId, (tx) =>
        tx
          .select()
          .from(webhookDeliveries)
          .where(
            and(
              endpointId === undefined ? undefined : eq(webhookDeliveries.endpointId, endpointId),
              status === undefined ? undefined : eq(webhookDeliveries.status, status),
              after === undefined
                ? undefined
                : sql`(${webhookDeliveries.createdAt}, ${webhookDeliveries.id}) < (${after.createdAt.toISOString()}::timestamptz, ${after.id}::uuid)`,
            ),
          )
          .orderBy(desc(webhookDeliveries.createdAt), desc(webhookDeliveries.id))
          .limit(limit + 1),
      );
      return rows.map(toView);
    },

    replay(tenantId, actor, id, at) {
      return withTenantTransaction(db, tenantId, async (tx) => {
        const before = (
          await tx.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, id))
        ).at(0);
        if (!before) return null;
        if (before.status !== 'dead') return 'not-dead';
        // The guard allows dead to pending and keeps attempt_count; the retry window restarts on its own.
        const row = (
          await tx
            .update(webhookDeliveries)
            .set({ status: 'pending', nextAttemptAt: at })
            .where(and(eq(webhookDeliveries.id, id), eq(webhookDeliveries.status, 'dead')))
            .returning()
        ).at(0);
        if (!row) return 'not-dead';
        await recordAudit(tx, {
          actor,
          action: 'webhook_delivery.replay',
          entity: { type: 'webhook_delivery', id },
          before: audited(before),
          after: audited(row),
        });
        return toView(row);
      });
    },
  };
}
