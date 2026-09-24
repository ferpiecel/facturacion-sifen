import { afterEach, describe, expect, it } from 'vitest';
import type { DatabaseHandle } from '../src/client.js';
import { assertNonPrivilegedSession } from '../src/session-guard.js';
import { connectAsRuntime, createTestDatabase } from './support/harness.js';

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
});
