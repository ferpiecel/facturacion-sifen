import { withPlatformAdminTransaction, type Database } from '@sifen/db';

const SYSTEM_ACTOR = 'system:worker';
/** Frequent worker jobs record at most one platform_admin use per purpose in this window (ADR-0023). */
const SYSTEM_AUDIT_WINDOW_SECONDS = 15 * 60;

/** Runs a recurring worker job as `platform_admin`, audited as the `system:worker` actor. */
export function asSystemPlatformAdmin<T>(
  db: Database,
  purpose: string,
  scope: readonly string[],
  fn: (tx: Database) => Promise<T>,
): Promise<T> {
  return withPlatformAdminTransaction(
    db,
    { actor: SYSTEM_ACTOR, purpose, scope, throttleSeconds: SYSTEM_AUDIT_WINDOW_SECONDS },
    fn,
  );
}
