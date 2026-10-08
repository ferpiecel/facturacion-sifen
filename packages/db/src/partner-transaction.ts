import { sql } from 'drizzle-orm';
import type { Database } from './client.js';
import { assertValidTenantId } from './tenant-id.js';

/** The transaction-scoped handle `fn` receives from {@link withPartnerTransaction}. */
export type PartnerTx = Database;

/**
 * Runs `fn` scoped to one partner (HU-E1-06, ADR-0014), the twin of `withTenantTransaction`: the UUID is validated
 * and bound as a parameter into `app.current_partner`, and the role becomes `partner_viewer` (operational columns
 * of the partner's own tenants only). Authorizing the caller for `partnerId` (`user_in_partner`) is the caller's job.
 */
export async function withPartnerTransaction<T>(
  db: Database,
  partnerId: string,
  fn: (tx: PartnerTx) => Promise<T>,
): Promise<T> {
  assertValidTenantId(partnerId);

  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.current_tenant', '', true)`);
    await tx.execute(sql`select set_config('app.current_partner', ${partnerId}, true)`);
    await tx.execute(sql`SET LOCAL ROLE partner_viewer`);
    return fn(tx);
  });
}
