import { and, asc, eq, inArray, lte, or } from 'drizzle-orm';
import {
  webhookDeliveries,
  webhookEndpoints,
  withTenantTransaction,
  type Database,
} from '@sifen/db';
import type { SealedSecret } from '../../custody/domain/sealed-secret.js';
import type { WebhookDeliveryStore } from '../application/ports/webhook-delivery-store.port.js';

export interface DrizzleWebhookDeliveryStoreOptions {
  readonly db: Database;
  readonly tenantId: string;
}

/** `WebhookDeliveryStore` over `webhook_deliveries`; every call runs as app_user in the tenant's transaction. */
export function createDrizzleWebhookDeliveryStore({
  db,
  tenantId,
}: DrizzleWebhookDeliveryStoreOptions): WebhookDeliveryStore {
  return {
    claimDue(now, limit, leaseMs) {
      return withTenantTransaction(db, tenantId, async (tx) => {
        const rows = await tx
          .select({ delivery: webhookDeliveries, endpoint: webhookEndpoints })
          .from(webhookDeliveries)
          .innerJoin(
            webhookEndpoints,
            and(
              eq(webhookEndpoints.tenantId, webhookDeliveries.tenantId),
              eq(webhookEndpoints.id, webhookDeliveries.endpointId),
            ),
          )
          .where(
            and(
              or(eq(webhookDeliveries.status, 'pending'), eq(webhookDeliveries.status, 'failed')),
              lte(webhookDeliveries.nextAttemptAt, now),
              eq(webhookEndpoints.active, true),
            ),
          )
          .orderBy(asc(webhookDeliveries.nextAttemptAt), asc(webhookDeliveries.id))
          .limit(limit)
          .for('update', { of: webhookDeliveries, skipLocked: true });
        if (rows.length > 0) {
          await tx
            .update(webhookDeliveries)
            .set({ nextAttemptAt: new Date(now.getTime() + leaseMs) })
            .where(
              inArray(
                webhookDeliveries.id,
                rows.map((row) => row.delivery.id),
              ),
            );
        }
        return rows.map(({ delivery, endpoint }) => ({
          id: delivery.id,
          tenantId: delivery.tenantId,
          endpointId: delivery.endpointId,
          url: endpoint.url,
          payload: delivery.payload as Record<string, unknown>,
          attemptCount: delivery.attemptCount,
          firstAttemptAt: delivery.firstAttemptAt,
          secret: {
            version: endpoint.secretVersion,
            sealed: endpoint.sealed as SealedSecret,
            previousSealed: endpoint.previousSealed as SealedSecret | null,
            previousExpiresAt: endpoint.previousExpiresAt,
          },
        }));
      });
    },

    async record(deliveryId, outcome) {
      await withTenantTransaction(db, tenantId, async (tx) => {
        const updated = await tx
          .update(webhookDeliveries)
          .set(outcome)
          .where(
            and(
              eq(webhookDeliveries.id, deliveryId),
              inArray(webhookDeliveries.status, ['pending', 'failed']),
            ),
          )
          .returning({ id: webhookDeliveries.id });
        if (updated.length !== 1) {
          throw new Error(`Webhook delivery ${deliveryId} is not pending or failed`);
        }
      });
    },
  };
}
