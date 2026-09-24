import { afterEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import type { Database, DatabaseHandle } from '../src/client.js';
import { TENANT_TABLES } from '../src/schema.js';
import { createTestDatabase, queryRows } from './support/harness.js';

interface TenantTableAudit {
  table: string;
  covered: boolean;
}

/**
 * Discovers every `public` table with a `tenant_id` column from the catalog
 * (never from `TENANT_TABLES`) and reports whether it has RLS enabled and
 * forced plus a `FOR ALL` policy for `app_user` with both USING and WITH
 * CHECK.
 */
async function auditTenantTables(db: Database): Promise<TenantTableAudit[]> {
  return queryRows<TenantTableAudit>(
    db,
    sql`select c.relname as "table",
          c.relrowsecurity and c.relforcerowsecurity and exists (
            select 1 from pg_policies p
            where p.schemaname = 'public' and p.tablename = c.relname
              and 'app_user' = any(p.roles) and p.cmd = 'ALL'
              and p.qual is not null and p.with_check is not null
          ) as covered
        from pg_class c
        join pg_attribute a on a.attrelid = c.oid and a.attname = 'tenant_id' and not a.attisdropped
        where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p')
        order by c.relname`,
  );
}

async function findRlsGaps(db: Database): Promise<string[]> {
  const audit = await auditTenantTables(db);
  return audit.filter((row) => !row.covered).map((row) => row.table);
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

    const audit = await auditTenantTables(handle.db);
    expect(audit.map((row) => row.table)).toEqual([...TENANT_TABLES].sort());
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
