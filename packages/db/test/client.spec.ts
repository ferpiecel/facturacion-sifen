import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createNodePostgresDatabase, type DatabaseHandle } from '../src/client.js';
import { tenantProbe, tenants } from '../src/schema.js';
import { createTestDatabase } from './support/harness.js';

describe('packages/db scaffold', () => {
  let handle: DatabaseHandle | undefined;

  afterEach(async () => {
    await handle?.close();
    handle = undefined;
  });

  it('migrates and round-trips a row through the generated schema', async () => {
    handle = await createTestDatabase();

    const [tenant] = await handle.db.insert(tenants).values({ name: 'Acme SA' }).returning();
    expect(tenant.id).toBeDefined();
    expect(tenant.name).toBe('Acme SA');

    await handle.db.insert(tenantProbe).values({ tenantId: tenant.id, label: 'probe-1' });

    const rows = await handle.db
      .select()
      .from(tenantProbe)
      .where(eq(tenantProbe.tenantId, tenant.id));

    expect(rows).toHaveLength(1);
    expect(rows[0]?.label).toBe('probe-1');
  });

  it('rejects a tenant-scoped row whose tenant does not exist', async () => {
    handle = await createTestDatabase();

    await expect(
      handle.db
        .insert(tenantProbe)
        .values({ tenantId: '00000000-0000-4000-8000-000000000000', label: 'orphan' }),
    ).rejects.toThrow();
  });

  it('creates a node-postgres handle lazily, without connecting', () => {
    // `pg.Pool` only opens a connection on first query/migrate, so building
    // the handle and closing it again never requires a reachable Postgres
    // instance. The `migrate()` branch is exercised by `test:postgres` in
    // CI, against a real testcontainers database.
    handle = createNodePostgresDatabase('postgres://sifen:sifen@127.0.0.1:1/sifen_unused');

    expect(handle.db).toBeDefined();
    // afterEach() below exercises close() so it is never called twice on
    // the same pool.
  });
});
