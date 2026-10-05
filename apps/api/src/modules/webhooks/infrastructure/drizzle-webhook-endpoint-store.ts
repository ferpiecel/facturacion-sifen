import { and, asc, eq } from 'drizzle-orm';
import { webhookEndpoints, withTenantTransaction, type Database } from '@sifen/db';
import { recordAudit } from '../../audit/infrastructure/record-audit.js';
import type { SealedSecret } from '../../custody/domain/sealed-secret.js';
import type {
  EndpointView,
  WebhookEndpointStore,
} from '../application/ports/webhook-endpoint-store.port.js';

type Row = typeof webhookEndpoints.$inferSelect;

const toView = (row: Row): EndpointView => ({
  id: row.id,
  url: row.url,
  events: row.events,
  active: row.active,
  secretVersion: row.secretVersion,
  previousExpiresAt: row.previousExpiresAt,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

/**
 * Audit shape: never the sealed secret. The version is called `key_version` because the audit
 * redactor masks any key containing "secret".
 */
/** Scheme, host and path only: a query string or fragment may carry a token. */
const auditableUrl = (url: string): string => url.split(/[?#]/)[0];

const audited = (row: Row) => ({
  url: auditableUrl(row.url),
  events: row.events,
  active: row.active,
  key_version: row.secretVersion,
});

const ENTITY = 'webhook_endpoint';

/** `WebhookEndpointStore` over `webhook_endpoints`: app_user inside the tenant's transaction, audit in the same one. */
export function createDrizzleWebhookEndpointStore(db: Database): WebhookEndpointStore {
  // RLS already scopes every query to the tenant; the explicit predicate is defence in depth.
  const byId = (tenantId: string, id: string) =>
    and(eq(webhookEndpoints.tenantId, tenantId), eq(webhookEndpoints.id, id));
  return {
    insert(tenantId, actor, { id, url, events, sealed }) {
      return withTenantTransaction(db, tenantId, async (tx) => {
        const [row] = await tx
          .insert(webhookEndpoints)
          .values({ id, tenantId, url, events: [...events], sealed })
          .returning();
        await recordAudit(tx, {
          actor,
          action: `${ENTITY}.create`,
          entity: { type: ENTITY, id },
          before: null,
          after: audited(row),
        });
        return toView(row);
      });
    },

    async list(tenantId) {
      const rows = await withTenantTransaction(db, tenantId, (tx) =>
        tx
          .select()
          .from(webhookEndpoints)
          .orderBy(asc(webhookEndpoints.createdAt), asc(webhookEndpoints.id)),
      );
      return rows.map(toView);
    },

    async find(tenantId, id) {
      const rows = await withTenantTransaction(db, tenantId, (tx) =>
        tx.select().from(webhookEndpoints).where(byId(tenantId, id)),
      );
      const row = rows.at(0);
      return row
        ? {
            ...toView(row),
            sealed: row.sealed as SealedSecret,
            previousSealed: row.previousSealed as SealedSecret | null,
          }
        : null;
    },

    update(tenantId, actor, id, patch) {
      return withTenantTransaction(db, tenantId, async (tx) => {
        const before = (await tx.select().from(webhookEndpoints).where(byId(tenantId, id))).at(0);
        if (!before) return null;
        const [row] = await tx
          .update(webhookEndpoints)
          .set({
            ...(patch.url !== undefined ? { url: patch.url } : {}),
            ...(patch.events !== undefined ? { events: [...patch.events] } : {}),
            ...(patch.active !== undefined ? { active: patch.active } : {}),
          })
          .where(byId(tenantId, id))
          .returning();
        await recordAudit(tx, {
          actor,
          action: `${ENTITY}.update`,
          entity: { type: ENTITY, id },
          before: audited(before),
          after: audited(row),
        });
        return toView(row);
      });
    },

    rotate(tenantId, actor, id, change) {
      return withTenantTransaction(db, tenantId, async (tx) => {
        const before = (await tx.select().from(webhookEndpoints).where(byId(tenantId, id))).at(0);
        if (!before) return null;
        if (before.secretVersion !== change.expectedVersion) return 'stale';
        // The guard trigger enforces version + 1, previous = old sealed, and a 7 day overlap at most.
        const rows = await tx
          .update(webhookEndpoints)
          .set({
            sealed: change.sealed,
            secretVersion: change.expectedVersion + 1,
            previousSealed: change.previousSealed,
            previousExpiresAt: change.previousExpiresAt,
          })
          .where(
            and(byId(tenantId, id), eq(webhookEndpoints.secretVersion, change.expectedVersion)),
          )
          .returning();
        const row = rows.at(0);
        // A concurrent rotation can win between the read above and this write: nothing to audit.
        if (row === undefined) return 'stale';
        await recordAudit(tx, {
          actor,
          action: `${ENTITY}.rotate_secret`,
          entity: { type: ENTITY, id },
          before: audited(before),
          after: audited(row),
        });
        return toView(row);
      });
    },
  };
}
