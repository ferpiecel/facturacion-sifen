import { eq } from 'drizzle-orm';
import { tenantFiscalProfiles, withTenantTransaction, type Database } from '@sifen/db';
import type { TenantFiscalIdentity } from '../../application/ports/tenant-fiscal-identity.port.js';

/** Reads only the RUC pair of `tenant_fiscal_profiles`, inside the tenant transaction (RLS). */
export function createDrizzleTenantFiscalIdentity(db: Database): TenantFiscalIdentity {
  return {
    getRucIdentity(tenantId) {
      return withTenantTransaction(db, tenantId, async (tx) => {
        const row = (
          await tx
            .select({ rucBase: tenantFiscalProfiles.rucBase, rucDv: tenantFiscalProfiles.rucDv })
            .from(tenantFiscalProfiles)
            .where(eq(tenantFiscalProfiles.tenantId, tenantId))
        ).at(0);
        return row === undefined ? null : { rucBase: row.rucBase, dv: row.rucDv };
      });
    },
  };
}
