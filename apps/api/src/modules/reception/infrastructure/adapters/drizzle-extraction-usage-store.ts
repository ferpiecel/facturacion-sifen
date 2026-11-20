import { sql } from 'drizzle-orm';
import { receptionExtractionUsage, withTenantTransaction, type Database } from '@sifen/db';
import type { ExtractionUsageStore } from '../../application/ports/extraction-usage-store.port.js';

/**
 * Daily extraction counter in `reception_extraction_usage`, inside the tenant transaction (RLS).
 * Taking a slot is ONE statement, `INSERT ... ON CONFLICT DO UPDATE ... WHERE used < cap`: Postgres
 * locks the conflicting row, so concurrent calls serialize on it and none can pass the cap. No row
 * comes back when the cap is reached.
 */
export function createDrizzleExtractionUsageStore(db: Database): ExtractionUsageStore {
  const table = receptionExtractionUsage;
  return {
    tryConsume(tenantId, usageDate, cap) {
      return withTenantTransaction(db, tenantId, async (tx) => {
        const rows = await tx
          .insert(table)
          .values({ tenantId, usageDate, used: 1 })
          .onConflictDoUpdate({
            target: [table.tenantId, table.usageDate],
            set: { used: sql`${table.used} + 1`, updatedAt: sql`now()` },
            setWhere: sql`${table.used} < ${cap}`,
          })
          .returning({ used: table.used });
        return rows.at(0)?.used ?? null;
      });
    },
    async release(tenantId, usageDate) {
      await withTenantTransaction(db, tenantId, async (tx) => {
        await tx
          .update(table)
          .set({ used: sql`greatest(${table.used} - 1, 0)`, updatedAt: sql`now()` })
          .where(sql`${table.tenantId} = ${tenantId} and ${table.usageDate} = ${usageDate}`);
      });
    },
  };
}
