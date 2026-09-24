import { sql } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import type { DatabaseHandle } from '../src/client.js';
import { withAppRoleTransaction } from '../src/app-role-transaction.js';
import { createTestDatabase, queryRows } from './support/harness.js';

/**
 * Spec: HU-E1-04 (DB part). The pre-authentication api-key lookup runs as
 * `app_user` (so RLS still applies, ADR-0016) but WITHOUT any tenant
 * context, because authentication has not resolved a tenant yet.
 */
describe('withAppRoleTransaction', () => {
  let handle: DatabaseHandle | undefined;

  afterEach(async () => {
    await handle?.close();
    handle = undefined;
  });

  it('runs fn with role app_user and no tenant context set', async () => {
    handle = await createTestDatabase();

    const rows = await withAppRoleTransaction(handle.db, (tx) =>
      queryRows<{ current_role: string; tenant_seen: string | null }>(
        tx,
        sql`select current_user as current_role,
                   nullif(current_setting('app.current_tenant', true), '') as tenant_seen`,
      ),
    );

    expect(rows[0]?.current_role).toBe('app_user');
    expect(rows[0]?.tenant_seen).toBeNull();
  });

  it('explicitly clears app.current_tenant to the empty string, not merely "never set"', async () => {
    handle = await createTestDatabase();

    // No `nullif`: an unset custom GUC also reads back as `null` here, so
    // this asserts the stronger, explicit guarantee — `set_config(...,
    // '', true)` ran — rather than only "nothing set it yet".
    const rows = await withAppRoleTransaction(handle.db, (tx) =>
      queryRows<{ tenant_setting: string }>(
        tx,
        sql`select current_setting('app.current_tenant', true) as tenant_setting`,
      ),
    );

    expect(rows[0]?.tenant_setting).toBe('');
  });

  it('rolls back when fn throws', async () => {
    handle = await createTestDatabase();

    await expect(
      withAppRoleTransaction(handle.db, () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
  });

  it('returns the value produced by fn', async () => {
    handle = await createTestDatabase();

    const result = await withAppRoleTransaction(handle.db, () => Promise.resolve('ok'));

    expect(result).toBe('ok');
  });
});
