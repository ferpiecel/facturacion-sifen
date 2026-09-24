import { sql } from 'drizzle-orm';
import type { Database } from './client.js';
import { assertValidTenantId } from './tenant-id.js';

/** The transaction-scoped handle `fn` receives from {@link withTenantTransaction}. */
export type TenantTx = Database;

/**
 * Runs `fn` inside a single transaction scoped to `tenantId`:
 *
 * 1. Validates `tenantId` is a UUID *before* any SQL runs (never
 *    string-interpolated; a non-UUID never reaches the database).
 * 2. `BEGIN` (via `db.transaction`).
 * 3. `select set_config('app.current_tenant', $1, true)` with `tenantId`
 *    bound as a query parameter — never interpolated into the SQL text.
 * 4. `SET LOCAL ROLE app_user`, so every RLS policy for `app_user` applies.
 * 5. Runs `fn(tx)`, then commits on success or rolls back on throw.
 *
 * `SET LOCAL` and `set_config(..., true)` (the `is_local` argument) both
 * scope to the current transaction, so `app.current_tenant` and the role
 * never leak onto the underlying pooled connection after commit or
 * rollback (spec: tenant-isolation, no leak across transactions).
 */
export async function withTenantTransaction<T>(
  db: Database,
  tenantId: string,
  fn: (tx: TenantTx) => Promise<T>,
): Promise<T> {
  assertValidTenantId(tenantId);

  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.current_tenant', ${tenantId}, true)`);
    await tx.execute(sql`SET LOCAL ROLE app_user`);
    return fn(tx);
  });
}
