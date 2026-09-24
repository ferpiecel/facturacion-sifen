import { sql } from 'drizzle-orm';
import type { Database } from './client.js';

/** The transaction-scoped handle `fn` receives from {@link withAppRoleTransaction}. */
export type AppRoleTx = Database;

/**
 * Runs `fn` inside a single transaction with `SET LOCAL ROLE app_user` but
 * with NO tenant context set (`app.current_tenant` stays unset).
 *
 * This is the pre-authentication path (HU-E1-04): an incoming API key must
 * be resolved *before* the request has a tenant, so `withTenantTransaction`
 * cannot be used yet. `app_user` is never RLS-exempt, so every row reachable
 * through this transaction is still filtered by RLS — the only rows an
 * `app_user` session can see without a tenant context are the ones exposed
 * by the `resolve_api_key` / `touch_api_key_last_used` SECURITY DEFINER
 * functions (ADR-0005 / ADR-0016), never a direct table read.
 */
export async function withAppRoleTransaction<T>(
  db: Database,
  fn: (tx: AppRoleTx) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL ROLE app_user`);
    return fn(tx);
  });
}
