import { afterEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import type { DatabaseHandle } from '../src/client.js';
import { TENANT_TABLES } from '../src/schema.js';
import { createTestDatabase, queryRows } from './support/harness.js';

/**
 * Drift check (spec: tenant-isolation, Row-level tenant scoping via RLS):
 * every table listed in `TENANT_TABLES` MUST have `FORCE ROW LEVEL
 * SECURITY` and at least one policy. If a new tenant-scoped table is added
 * to the schema without RLS, this test fails instead of the gap shipping
 * silently.
 */
describe('RLS coverage drift check', () => {
  let handle: DatabaseHandle | undefined;

  afterEach(async () => {
    await handle?.close();
    handle = undefined;
  });

  it.each(TENANT_TABLES)('%s has FORCE ROW LEVEL SECURITY enabled', async (table) => {
    handle = await createTestDatabase();

    const rows = await queryRows<{ relforcerowsecurity: boolean }>(
      handle.db,
      sql`select relforcerowsecurity from pg_class where relname = ${table}`,
    );

    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]?.relforcerowsecurity).toBe(true);
  });

  it.each(TENANT_TABLES)('%s has at least one RLS policy', async (table) => {
    handle = await createTestDatabase();

    const rows = await queryRows<{ policyname: string }>(
      handle.db,
      sql`select policyname from pg_policies where tablename = ${table}`,
    );

    expect(rows.length).toBeGreaterThan(0);
  });
});
