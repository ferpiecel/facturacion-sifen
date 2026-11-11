import { userInfo } from 'node:os';
import { withPlatformAdminTransaction, type Database } from '@sifen/db';

/** What an operator command declares when it uses the cross-tenant role; recorded in the audit trail. */
export interface PlatformUse<T> {
  /** The command name, e.g. `usage:show`. */
  purpose: string;
  /** Tables the command reads or writes. */
  scope: readonly string[];
  /** Rows returned or affected, when it has a meaning. */
  rowCount?: (result: T) => number;
}

/** The operator behind the CLI: the OS login of the process that runs it. */
export function operatorActor(): string {
  return `ops-cli:${userInfo().username}`;
}

/**
 * Runs `fn` in one transaction as `platform_admin`, the deliberate cross-tenant role (ADR-0005), and
 * records the use in `platform_audit_log` (ADR-0023). The billing tables (plans, plan_prices,
 * subscriptions, payments) force RLS and only grant writes to that role, so the operator login must
 * be allowed to `SET ROLE platform_admin`.
 */
export function asPlatformAdmin<T>(
  db: Database,
  use: PlatformUse<T>,
  fn: (tx: Database) => Promise<T>,
): Promise<T> {
  return withPlatformAdminTransaction(db, { actor: operatorActor(), ...use }, fn);
}
