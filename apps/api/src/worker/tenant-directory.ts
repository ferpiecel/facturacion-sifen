import { asc, eq } from 'drizzle-orm';
import { tenants, type Database } from '@sifen/db';
import { asSystemPlatformAdmin } from './system-platform-use.js';

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
      const rows = await asSystemPlatformAdmin(db, 'worker:tenant-directory', ['tenants'], (tx) =>
        tx.select({ id: tenants.id }).from(tenants).orderBy(asc(tenants.id)),
      );
      return rows.map((row) => row.id);
    },
  };
}

/** The SIFEN environment a tenant currently works in. */
export interface TenantEnvironments {
  environmentOf(tenantId: string): Promise<'test' | 'production'>;
}

/** Reads `tenants.environment` as `platform_admin`; an unknown tenant is an error, never a default. */
export function createDrizzleTenantEnvironments(db: Database): TenantEnvironments {
  return {
    async environmentOf(tenantId) {
      const rows = await asSystemPlatformAdmin(db, 'worker:tenant-environment', ['tenants'], (tx) =>
        tx
          .select({ environment: tenants.environment })
          .from(tenants)
          .where(eq(tenants.id, tenantId)),
      );
      const row = rows.at(0);
      if (!row) throw new Error('tenant not found');
      return row.environment;
    },
  };
}
