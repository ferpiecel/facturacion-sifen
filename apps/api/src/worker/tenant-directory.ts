import { asc, sql } from 'drizzle-orm';
import { tenants, type Database } from '@sifen/db';

/** Which tenants the worker serves. */
export interface TenantDirectory {
  tenantIds(): Promise<readonly string[]>;
}

/**
 * Lists every tenant as `platform_admin`, the deliberate cross-tenant role (ADR-0005): the login of
 * the connection must be allowed to `SET ROLE platform_admin`. Reads ids only, inside one transaction.
 * Every tenant is served: a tenant without work costs four cheap indexed queries per cycle.
 */
export function createDrizzleTenantDirectory(db: Database): TenantDirectory {
  return {
    async tenantIds() {
      const rows = await db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL ROLE platform_admin`);
        return tx.select({ id: tenants.id }).from(tenants).orderBy(asc(tenants.id));
      });
      return rows.map((row) => row.id);
    },
  };
}
