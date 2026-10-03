import { and, desc, eq, sql } from 'drizzle-orm';
import {
  webhookDeliveries,
  webhookEndpoints,
  withTenantTransaction,
  type Database,
} from '@sifen/db';
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
              eq(webhookDeliveries.tenantId, tenantId),
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
        // RLS already scopes every query to the tenant; the explicit predicates are defence in depth.
        const mine = and(eq(webhookDeliveries.tenantId, tenantId), eq(webhookDeliveries.id, id));
        const before = (await tx.select().from(webhookDeliveries).where(mine)).at(0);
        if (!before) return null;
        if (before.status !== 'dead') return 'not-dead';
        const endpoint = (
          await tx
            .select({ active: webhookEndpoints.active })
            .from(webhookEndpoints)
            .where(
              and(
                eq(webhookEndpoints.tenantId, tenantId),
                eq(webhookEndpoints.id, before.endpointId),
              ),
            )
        ).at(0);
        if (!endpoint?.active) return 'endpoint-inactive';
        // The guard allows dead to pending and keeps attempt_count. first_attempt_at is immutable, so the
        // 24 h retry window of the original delivery is already over: a replay gets exactly one attempt,
        // and fails back to dead unless it succeeds.
        const row = (
          await tx
            .update(webhookDeliveries)
            .set({ status: 'pending', nextAttemptAt: at })
            .where(and(mine, eq(webhookDeliveries.status, 'dead')))
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
