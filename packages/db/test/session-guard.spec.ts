import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import type { DatabaseHandle } from '../src/client.js';
import { assertNonPrivilegedSession } from '../src/session-guard.js';
import { connectAs, connectAsRuntime, createTestDatabase } from './support/harness.js';

/**
 * Security-review debt item (PR2 exploit: runtime pool ran as the
 * superuser table owner). This guard is the startup/handle-creation check
 * that refuses to let the application run any query through a session that
 * can bypass RLS, so a future misconfiguration is caught immediately
 * instead of silently reopening the escape.
 */
describe('assertNonPrivilegedSession', () => {
  let handle: DatabaseHandle | undefined;

  afterEach(async () => {
    await handle?.close();
    handle = undefined;
  });

  // pglite always connects as a superuser (its `username` option is only a
  // `SET ROLE`, never a real login) — see isolation.spec.ts. That makes it
  // the reliable way to prove this guard actually fires, on every driver,
  // without depending on the postgres-only leg.
  it('throws when the session is a superuser', async () => {
    handle = await createTestDatabase();

    await expect(assertNonPrivilegedSession(handle.db)).rejects.toThrow(/bypass RLS/);
  });

  it.runIf(process.env.DB_TEST_DRIVER === 'postgres')(
    'resolves for the non-privileged app_login runtime role',
    async () => {
      handle = await createTestDatabase();
      const runtime = connectAsRuntime(handle);

      try {
        await expect(assertNonPrivilegedSession(runtime.db)).resolves.toBeUndefined();
      } finally {
        await runtime.close();
      }
    },
  );

  // pglite has a single superuser session and no real logins, so none of
  // these privilege shapes can be built there; they run on the postgres leg.
  describe.runIf(process.env.DB_TEST_DRIVER === 'postgres')('rejects escapable sessions', () => {
    // Roles are cluster-wide, so every test creates its own uniquely named login.
    async function rejectsLogin(grant: (login: string) => string, role?: string) {
      handle = await createTestDatabase();
      const login = `guard_${randomUUID().slice(0, 8)}`;
      await handle.db.execute(sql.raw(`CREATE ROLE ${login} LOGIN PASSWORD '${login}'`));
      await handle.db.execute(sql.raw(grant(login)));
      const session = connectAs(handle, login, login, role);
      try {
        await expect(assertNonPrivilegedSession(session.db)).rejects.toThrow(/bypass RLS/);
      } finally {
        await session.close();
      }
    }

    it('a login with BYPASSRLS', async () => {
      await rejectsLogin((login) => `ALTER ROLE ${login} BYPASSRLS`);
    });

    it('a login that owns the RLS-protected tenants table', async () => {
      await rejectsLogin((login) => `ALTER TABLE tenants OWNER TO ${login}`);
    });

    it('a login that is a member of platform_admin', async () => {
      await rejectsLogin((login) => `GRANT platform_admin TO ${login}`);
    });

    it('a superuser session that SET ROLE app_login (session_user check)', async () => {
      handle = await createTestDatabase();
      const session = connectAs(handle, 'sifen', 'sifen', 'app_login');
      try {
        await expect(assertNonPrivilegedSession(session.db)).rejects.toThrow(/bypass RLS/);
      } finally {
        await session.close();
      }
    });
  });
});
