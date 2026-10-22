import { sql } from 'drizzle-orm';
import type { Database } from '@sifen/db';

/**
 * Runs `fn` in one transaction as `platform_admin`, the deliberate cross-tenant role (ADR-0005). The
 * billing tables (plans, plan_prices, subscriptions, payments) force RLS and only grant writes to that
 * role, so the operator login must be allowed to `SET ROLE platform_admin`.
 */
export async function asPlatformAdmin<T>(
  db: Database,
  fn: (tx: Database) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL ROLE platform_admin`);
    return fn(tx);
  });
}
