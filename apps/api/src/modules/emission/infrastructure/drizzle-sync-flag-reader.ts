import { eq } from 'drizzle-orm';
import { tenantFiscalProfiles, withTenantTransaction, type Database } from '@sifen/db';

/** HU-E6-06: whether the tenant opted in to synchronous transmission. No profile means no. */
export function createDrizzleSyncFlagReader(db: Database) {
  return async (tenantId: string): Promise<boolean> => {
    const rows = await withTenantTransaction(db, tenantId, (tx) =>
      tx
        .select({ enabled: tenantFiscalProfiles.syncTransmission })
        .from(tenantFiscalProfiles)
        .where(eq(tenantFiscalProfiles.tenantId, tenantId)),
    );
    return rows.at(0)?.enabled === true;
  };
}
