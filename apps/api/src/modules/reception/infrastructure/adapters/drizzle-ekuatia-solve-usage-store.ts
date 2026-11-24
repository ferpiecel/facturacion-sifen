import { sql } from 'drizzle-orm';
import {
  receptionEkuatiaGlobalUsage,
  receptionEkuatiaSolveUsage,
  withTenantTransaction,
  type Database,
} from '@sifen/db';
import type {
  SolveReservation,
  SolveUsageStore,
} from '../../application/ports/solve-usage-store.port.js';

/** Thrown inside the transaction to roll the tenant increment back when the global cap is full. */
class GlobalCapReached extends Error {}

/**
 * Paid-solve counters in `reception_ekuatia_solve_usage` (per tenant, RLS) and
 * `reception_ekuatia_global_usage` (platform-wide, no tenant column), both inside ONE tenant
 * transaction so a refusal on either cap leaves both counters unchanged. Each increment is the
 * one-statement `INSERT ... ON CONFLICT DO UPDATE ... WHERE used < cap` of the extraction counter
 * (R5.9): Postgres locks the conflicting row, so concurrent calls serialize on it. The tenant row
 * is always locked before the global row, so two calls cannot deadlock.
 */
export function createDrizzleEkuatiaSolveUsageStore(db: Database): SolveUsageStore {
  const tenantTable = receptionEkuatiaSolveUsage;
  const globalTable = receptionEkuatiaGlobalUsage;
  return {
    async tryConsume(tenantId, usageDate, caps): Promise<SolveReservation> {
      try {
        return await withTenantTransaction(db, tenantId, async (tx) => {
          const tenantRows = await tx
            .insert(tenantTable)
            .values({ tenantId, usageDate, used: 1 })
            .onConflictDoUpdate({
              target: [tenantTable.tenantId, tenantTable.usageDate],
              set: { used: sql`${tenantTable.used} + 1`, updatedAt: sql`now()` },
              setWhere: sql`${tenantTable.used} < ${caps.tenant}`,
            })
            .returning({ used: tenantTable.used });
          if (tenantRows.length === 0) return { ok: false, scope: 'tenant' } as const;
          const globalRows = await tx
            .insert(globalTable)
            .values({ usageDate, used: 1 })
            .onConflictDoUpdate({
              target: globalTable.usageDate,
              set: { used: sql`${globalTable.used} + 1`, updatedAt: sql`now()` },
              setWhere: sql`${globalTable.used} < ${caps.global}`,
            })
            .returning({ used: globalTable.used });
          if (globalRows.length === 0) throw new GlobalCapReached();
          return { ok: true } as const;
        });
      } catch (error) {
        if (error instanceof GlobalCapReached) return { ok: false, scope: 'global' };
        throw error;
      }
    },
    async release(tenantId, usageDate) {
      await withTenantTransaction(db, tenantId, async (tx) => {
        await tx
          .update(tenantTable)
          .set({ used: sql`greatest(${tenantTable.used} - 1, 0)`, updatedAt: sql`now()` })
          .where(
            sql`${tenantTable.tenantId} = ${tenantId} and ${tenantTable.usageDate} = ${usageDate}`,
          );
        await tx
          .update(globalTable)
          .set({ used: sql`greatest(${globalTable.used} - 1, 0)`, updatedAt: sql`now()` })
          .where(sql`${globalTable.usageDate} = ${usageDate}`);
      });
    },
  };
}
