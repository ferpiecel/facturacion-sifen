import { sql } from 'drizzle-orm';
import type { Database } from './client.js';

/** The transaction-scoped handle `fn` receives from {@link withAppRoleTransaction}. */
export type AppRoleTx = Database;

/**
 * Runs `fn` inside a single transaction with `SET LOCAL ROLE app_user` and
 * `app.current_tenant` explicitly cleared to `''` — never merely "unset".
 *
 * This is the pre-authentication path (HU-E1-04): an incoming API key must
 * be resolved *before* the request has a tenant, so `withTenantTransaction`
 * cannot be used yet. `app_user` is never RLS-exempt, so every row reachable
 * through this transaction is still filtered by RLS — the only rows an
 * `app_user` session can see without a tenant context are the ones exposed
 * by the `resolve_api_key` / `touch_api_key_last_used` SECURITY DEFINER
 * functions (ADR-0005 / ADR-0016), never a direct table read.
 *
 * The explicit `set_config('app.current_tenant', '', true)` is defense in
 * depth against connection-pool reuse: `SET LOCAL`/`is_local=true` already
 * scope both statements to this transaction (they cannot leak to the
 * pooled connection after commit/rollback, spec: tenant-isolation), but
 * clearing the setting here — rather than relying on it having never been
 * set — means this function's guarantee ("no tenant context") does not
 * depend on the order transactions run in on a shared connection.
 *
 * `SET LOCAL ROLE app_user` reverting to `app_login` (the session/login
 * role, restored automatically at transaction end, no explicit
 * `RESET ROLE` needed) is safe *only* because `app_login` itself has no
 * table grants and is not a member of any role beyond being allowed to
 * `SET ROLE app_user` (ADR-0005) — it cannot read or write anything on
 * its own, with or without a tenant context.
 */
export async function withAppRoleTransaction<T>(
  db: Database,
  fn: (tx: AppRoleTx) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.current_tenant', '', true)`);
    await tx.execute(sql`SET LOCAL ROLE app_user`);
    return fn(tx);
  });
}
