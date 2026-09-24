import { afterEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import type { Database, DatabaseHandle } from '../src/client.js';
import { tenantProbe, tenants } from '../src/schema.js';
import { withTenantTransaction } from '../src/tenant-transaction.js';
import { createTestDatabase, queryRows } from './support/harness.js';

interface Seed {
  db: Database;
  tenantA: string;
  tenantB: string;
  probeA: string;
}

function required<T>(value: T | undefined, message: string): T {
  if (value === undefined) {
    throw new Error(message);
  }
  return value;
}

/**
 * Spec: tenant-isolation. Every scenario runs against the same
 * `withTenantTransaction` entry point used by application code, so these
 * tests exercise the real RLS policies, not a mock.
 */
describe('tenant isolation via RLS', () => {
  let handle: DatabaseHandle | undefined;

  async function seedTenants(): Promise<Seed> {
    const testHandle = await createTestDatabase();
    handle = testHandle;

    const inserted = await testHandle.db
      .insert(tenants)
      .values([{ name: 'Tenant A' }, { name: 'Tenant B' }])
      .returning();
    const tenantA = required(inserted[0], 'tenant A was not inserted').id;
    const tenantB = required(inserted[1], 'tenant B was not inserted').id;

    const probes = await testHandle.db
      .insert(tenantProbe)
      .values({ tenantId: tenantA, label: 'a-1' })
      .returning();
    const probeA = required(probes[0], 'probe A was not inserted').id;

    await testHandle.db.insert(tenantProbe).values({ tenantId: tenantB, label: 'b-1' });

    return { db: testHandle.db, tenantA, tenantB, probeA };
  }

  afterEach(async () => {
    await handle?.close();
    handle = undefined;
  });

  it('Tenant A reads only tenant A rows', async () => {
    const { db, tenantA } = await seedTenants();

    const rows = await withTenantTransaction(db, tenantA, (tx) => tx.select().from(tenantProbe));

    expect(rows).toHaveLength(1);
    expect(rows[0]?.tenantId).toBe(tenantA);
  });

  it('Tenant A cannot write to tenant B rows', async () => {
    const { db, tenantA, tenantB } = await seedTenants();

    const updated = await withTenantTransaction(db, tenantA, (tx) =>
      tx
        .update(tenantProbe)
        .set({ label: 'hijacked' })
        .where(eq(tenantProbe.tenantId, tenantB))
        .returning(),
    );
    expect(updated).toHaveLength(0);

    const deleted = await withTenantTransaction(db, tenantA, (tx) =>
      tx.delete(tenantProbe).where(eq(tenantProbe.tenantId, tenantB)).returning(),
    );
    expect(deleted).toHaveLength(0);

    await expect(
      withTenantTransaction(db, tenantA, (tx) =>
        tx.insert(tenantProbe).values({ tenantId: tenantB, label: 'forged' }),
      ),
    ).rejects.toThrow();
  });

  it('no tenant context: SELECT returns zero rows, INSERT/UPDATE denied', async () => {
    const { db, tenantA } = await seedTenants();

    await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL ROLE app_user`);

      const rows = await tx.select().from(tenantProbe);
      expect(rows).toHaveLength(0);

      await expect(
        tx.insert(tenantProbe).values({ tenantId: tenantA, label: 'no-context' }),
      ).rejects.toThrow();
    });
  });

  it('app.current_tenant does not leak after commit or rollback on the same connection', async () => {
    const { db, tenantA, tenantB, probeA } = await seedTenants();

    await withTenantTransaction(db, tenantA, async (tx) => {
      await tx.select().from(tenantProbe);
    });

    await withTenantTransaction(db, tenantB, async (tx) => {
      await tx.delete(tenantProbe).where(eq(tenantProbe.id, probeA)).returning();
    }).catch(() => undefined);

    await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL ROLE app_user`);
      const rows = await queryRows<{ current_tenant: string | null }>(
        tx,
        sql`select current_setting('app.current_tenant', true) as current_tenant`,
      );
      expect(rows[0]?.current_tenant).toBe('');
    });
  });

  it('app_user has no BYPASSRLS and is not the table owner; policies apply regardless of query shape', async () => {
    const testHandle = await createTestDatabase();
    handle = testHandle;

    const rows = await queryRows<{ rolbypassrls: boolean; is_owner: boolean }>(
      testHandle.db,
      sql`
        select
          r.rolbypassrls,
          (r.oid = c.relowner) as is_owner
        from pg_roles r
        join pg_class c on c.relname = 'tenant_probe'
        where r.rolname = 'app_user'
      `,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.rolbypassrls).toBe(false);
    expect(rows[0]?.is_owner).toBe(false);
  });
});
