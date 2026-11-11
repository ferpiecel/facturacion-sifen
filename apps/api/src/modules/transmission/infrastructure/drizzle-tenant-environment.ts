import { eq } from 'drizzle-orm';
import { tenants, withTenantTransaction, type Database } from '@sifen/db';

/** Reads `tenants.environment` inside the tenant's own scope; an unknown tenant is an error. */
export function createDrizzleTenantEnvironment(db: Database): {
  environmentOf(tenantId: string): Promise<'test' | 'production'>;
} {
  return {
    async environmentOf(tenantId) {
      const rows = await withTenantTransaction(db, tenantId, (tx) =>
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
