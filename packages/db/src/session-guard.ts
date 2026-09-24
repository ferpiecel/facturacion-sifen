import { sql } from 'drizzle-orm';
import type { Database } from './client.js';
import { PrivilegedSessionError, type SessionPrivilege } from './errors.js';

/**
 * Refuses to let the application run any query through a session that can
 * bypass RLS. Both `session_user` (the login, which `RESET ROLE` restores)
 * and `current_user` are checked, together with every role the login can
 * `SET ROLE` to (`pg_has_role(..., 'MEMBER')`, which ignores NOINHERIT).
 * The session is rejected if any of those roles:
 *
 * - is a superuser or has `BYPASSRLS`;
 * - owns a table in `public` with RLS enabled (owners bypass RLS unless
 *   FORCEd, and can drop FORCE anyway), read from the catalog so a new
 *   protected table is covered without touching this guard;
 * - is `platform_admin`, the deliberate cross-tenant role (ADR-0005).
 *
 * Call this once, right after the API creates its `DatabaseHandle`, before
 * any application query runs. See ADR-0016.
 */
export async function assertNonPrivilegedSession(db: Database): Promise<void> {
  const result = (await db.execute(sql`
    with protected_owner as (
      select c.relowner as oid
      from pg_class c
      where c.relnamespace = 'public'::regnamespace and c.relrowsecurity
    ),
    reachable as (
      select r.oid, r.rolname, r.rolsuper, r.rolbypassrls
      from pg_roles r
      where pg_has_role(session_user, r.oid, 'MEMBER') or r.rolname = current_user
    )
    select
      coalesce(bool_or(rolsuper), true) as "rolsuper",
      coalesce(bool_or(rolbypassrls), true) as "rolbypassrls",
      coalesce(bool_or(oid in (select oid from protected_owner)), true) as "ownsProtectedTable",
      coalesce(bool_or(rolname = 'platform_admin'), true) as "platformAdmin"
    from reachable
  `)) as { rows: SessionPrivilege[] };

  // An aggregate always returns one row; `coalesce(..., true)` fails closed
  // if `reachable` were ever empty.
  const [session] = result.rows as [SessionPrivilege];
  if (Object.values(session).some(Boolean)) {
    throw new PrivilegedSessionError(session);
  }
}
