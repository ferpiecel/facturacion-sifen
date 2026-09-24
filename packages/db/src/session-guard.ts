import { sql } from 'drizzle-orm';
import type { Database } from './client.js';
import { PrivilegedSessionError } from './errors.js';
import { TENANT_TABLES } from './schema.js';

interface SessionPrivilege {
  rolsuper: boolean;
  rolbypassrls: boolean;
  ownsTenantTable: boolean;
}

/**
 * Refuses to let the application run any query through a session that can
 * bypass RLS: a superuser, an explicit `BYPASSRLS` role, or a role that
 * owns a tenant-scoped table (table owners bypass RLS regardless of role
 * attributes). Call this once, right after the API creates its
 * `DatabaseHandle`, before any application query runs.
 *
 * Security-review debt item from PR2: the first RLS implementation ran the
 * runtime pool as the superuser table owner, so `RESET ROLE` restored a
 * full RLS bypass from inside `withTenantTransaction` (see ADR-0016 and
 * engram `security/rls-app-login-role`). `SET LOCAL ROLE` alone protects
 * against mistakes, not against a session that can already escape.
 */
export async function assertNonPrivilegedSession(db: Database): Promise<void> {
  const result = (await db.execute(sql`
    select
      r.rolsuper as "rolsuper",
      r.rolbypassrls as "rolbypassrls",
      exists (
        select 1 from pg_class c
        where c.relname = any(array[${sql.join(
          TENANT_TABLES.map((table) => sql`${table}`),
          sql`, `,
        )}])
          and c.relnamespace = 'public'::regnamespace
          and c.relowner = r.oid
      ) as "ownsTenantTable"
    from pg_roles r
    where r.rolname = current_user
  `)) as { rows: SessionPrivilege[] };

  const session = result.rows.at(0);
  /* v8 ignore next -- `where r.rolname = current_user` always matches the
   * connected session's own role in pg_roles; `session` is undefined only
   * if that invariant breaks, which no reachable test scenario forces. */
  if (!session || session.rolsuper || session.rolbypassrls || session.ownsTenantTable) {
    throw new PrivilegedSessionError(session);
  }
}
