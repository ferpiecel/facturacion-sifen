import { afterEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import type { Database, DatabaseHandle } from '../src/client.js';
import { TENANT_TABLES } from '../src/schema.js';
import { createTestDatabase, queryRows } from './support/harness.js';

/**
 * Returns every tenant-scoped table that lacks `FORCE ROW LEVEL SECURITY`
 * or a tenant-isolation policy.
 */
async function findRlsGaps(db: Database): Promise<string[]> {
  const gaps: string[] = [];
  for (const table of TENANT_TABLES) {
    const rows = await queryRows<{ forced: boolean; policies: number }>(
      db,
      sql`select c.relforcerowsecurity as forced,
            (select count(*)::int from pg_policies p where p.tablename = c.relname) as policies
          from pg_class c where c.relname = ${table}`,
    );
    if (!rows[0]?.forced || rows[0].policies === 0) {
      gaps.push(table);
    }
  }
  return gaps;
}

/**
 * Drift check (spec: tenant-isolation, Row-level tenant scoping via RLS):
 * a new tenant-scoped table added without RLS fails this suite instead of
 * the gap shipping silently.
 */
describe('RLS coverage drift check', () => {
  let handle: DatabaseHandle | undefined;

  afterEach(async () => {
    await handle?.close();
    handle = undefined;
  });

  it('every migrated tenant-scoped table is covered', async () => {
    handle = await createTestDatabase();

    expect(await findRlsGaps(handle.db)).toEqual([]);
  });

  it('flags a tenant_id table created without RLS', async () => {
    handle = await createTestDatabase();
    await handle.db.execute(sql`create table rogue_probe (id uuid primary key, tenant_id uuid)`);

    expect(await findRlsGaps(handle.db)).toContain('rogue_probe');
  });

  it('flags a tenant_id table whose policy is not app_user FOR ALL WITH CHECK', async () => {
    handle = await createTestDatabase();
    await handle.db.execute(sql`create table weak_probe (id uuid primary key, tenant_id uuid)`);
    await handle.db.execute(sql`alter table weak_probe enable row level security`);
    await handle.db.execute(sql`alter table weak_probe force row level security`);
    await handle.db.execute(sql`create policy p on weak_probe for select to app_user using (true)`);

    expect(await findRlsGaps(handle.db)).toContain('weak_probe');
  });
});
