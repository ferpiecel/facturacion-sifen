import { sql } from 'drizzle-orm';
import type { Database } from './client.js';

/** Who uses `platform_admin`, why and on what; recorded in `platform_audit_log` (ADR-0023). */
export type PlatformAdminContext<T> = {
  /** `ops-cli:<operator>` or `system:<job>`. */
  actor: string;
  /** Command or job name, e.g. `usage:show`. */
  purpose: string;
  /** Tables or datasets read or written. */
  scope: readonly string[];
  /** Rows returned or affected, derived from the result. Omitted when it has no meaning. */
  rowCount?: (result: T) => number;
  /**
   * For frequent system jobs: skip the record when the same actor and purpose already have one in
   * this window. The entry then means "used at least once in the window". Never for operators.
   */
  throttleSeconds?: number;
};

function requireText(value: string, name: string): void {
  if (value.trim() === '') {
    throw new Error(`platform_admin use requires a non-blank ${name}`);
  }
}

/**
 * The only way to run as `platform_admin`, the deliberate cross-tenant role (ADR-0005). Runs `fn` in
 * one transaction and appends the audit record inside it, after `fn`: if `fn` or the audit write
 * fails the whole transaction rolls back, so no cross-tenant access goes unrecorded.
 */
export async function withPlatformAdminTransaction<T>(
  db: Database,
  context: PlatformAdminContext<T>,
  fn: (tx: Database) => Promise<T>,
): Promise<T> {
  requireText(context.actor, 'actor');
  requireText(context.purpose, 'purpose');
  return db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL ROLE platform_admin`);
    const result = await fn(tx);
    const rows = context.rowCount?.(result) ?? null;
    const window = context.throttleSeconds;
    await tx.execute(sql`
      insert into platform_audit_log (actor, purpose, scope, row_count)
      select ${context.actor}, ${context.purpose}, ${JSON.stringify(context.scope)}::jsonb, ${rows}::integer
      where ${window ?? null}::integer is null or not exists (
        select 1 from platform_audit_log
        where actor = ${context.actor} and purpose = ${context.purpose}
          and occurred_at > now() - make_interval(secs => ${window ?? 0}::integer))`);
    return result;
  });
}
