import { afterEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import type { DatabaseHandle } from '../src/client.js';
import { tenantCscs, tenants } from '../src/schema.js';
import { withTenantTransaction } from '../src/tenant-transaction.js';
import { createTestDatabase, queryRows } from './support/harness.js';

const SEALED = {
  v: 1,
  keyId: 'k',
  wrappedKey: 'AA==',
  nonce: 'AA==',
  tag: 'AA==',
  ciphertext: 'AA==',
};

async function causeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    const cause = (error as { cause?: unknown }).cause;
    return cause instanceof Error ? cause.message : String(cause);
  }
  return expect.unreachable('expected the query to reject');
}

/** Spec: HU-E2-03 (DB part). CSCs are stored only sealed, max 2 per tenant and environment. */
describe('tenant_cscs', () => {
  let handle: DatabaseHandle | undefined;

  afterEach(async () => {
    await handle?.close();
    handle = undefined;
  });

  async function seed() {
    handle = await createTestDatabase();
    const rows = await handle.db
      .insert(tenants)
      .values([{ name: 'A' }, { name: 'B' }])
      .returning();
    const [a, b] = rows.map((row) => row.id);
    return { db: handle.db, a, b };
  }

  const csc = (
    tenantId: string,
    idCsc: string,
    environment: 'test' | 'production' = 'test',
    slot = Number(idCsc) % 2 === 0 ? 2 : 1,
  ) => ({ tenantId, environment, idCsc, slot, sealed: SEALED });

  it('has only the expected columns, none in clear', async () => {
    const { db } = await seed();
    const rows = await queryRows<{ column_name: string }>(
      db,
      sql`select column_name from information_schema.columns where table_name = 'tenant_cscs' order by column_name`,
    );
    expect(rows.map((r) => r.column_name)).toEqual([
      'created_at',
      'environment',
      'id',
      'id_csc',
      'sealed',
      'slot',
      'tenant_id',
    ]);
  });

  it('rejects an id_csc that is not 4 digits', async () => {
    const { db, a } = await seed();
    const message = await causeOf(db.insert(tenantCscs).values(csc(a, 'AB12')));
    expect(message).toContain('tenant_cscs_id_csc_format');
  });

  it('rejects a duplicate (tenant, environment, id_csc)', async () => {
    const { db, a } = await seed();
    await db.insert(tenantCscs).values(csc(a, '0001'));
    const message = await causeOf(db.insert(tenantCscs).values(csc(a, '0001')));
    expect(message).toContain('tenant_cscs_tenant_environment_id_csc_key');
  });

  it('allows 2 per environment and rejects the third, counting each environment apart', async () => {
    const { db, a } = await seed();
    await db.insert(tenantCscs).values([csc(a, '0001'), csc(a, '0002')]);
    expect(await causeOf(db.insert(tenantCscs).values(csc(a, '0003', 'test', 3)))).toContain(
      'tenant_cscs_slot_range',
    );
    expect(await causeOf(db.insert(tenantCscs).values(csc(a, '0003', 'test', 1)))).toContain(
      'tenant_cscs_tenant_environment_slot_key',
    );
    await db.insert(tenantCscs).values(csc(a, '0003', 'production', 1));
    expect(await db.select().from(tenantCscs).where(eq(tenantCscs.tenantId, a))).toHaveLength(3);
  });

  it('isolates reads by tenant through RLS', async () => {
    const { db, a, b } = await seed();
    await db.insert(tenantCscs).values([csc(a, '0001'), csc(b, '0001')]);

    const seen = await withTenantTransaction(db, a, (tx) => tx.select().from(tenantCscs));
    expect(seen.map((r) => r.tenantId)).toEqual([a]);
  });

  it('gives app_user SELECT only: insert, update and delete are permission errors', async () => {
    const { db, a } = await seed();
    await db.insert(tenantCscs).values(csc(a, '0001'));

    const attempts = [
      withTenantTransaction(db, a, (tx) => tx.insert(tenantCscs).values(csc(a, '0002'))),
      withTenantTransaction(db, a, (tx) => tx.update(tenantCscs).set({ idCsc: '0009' })),
      withTenantTransaction(db, a, (tx) => tx.delete(tenantCscs)),
    ];
    for (const attempt of attempts) {
      expect(await causeOf(attempt)).toContain('permission denied for table tenant_cscs');
    }
  });

  it('makes tenant_id and environment immutable, even for the owner', async () => {
    const { db, a, b } = await seed();
    await db.insert(tenantCscs).values(csc(a, '0001'));
    expect(await causeOf(db.update(tenantCscs).set({ tenantId: b }))).toContain('immutable');
    expect(await causeOf(db.update(tenantCscs).set({ environment: 'production' }))).toContain(
      'immutable',
    );
  });

  it.runIf(process.env.DB_TEST_DRIVER === 'postgres')(
    'never exceeds 2 CSC under concurrent inserts',
    async () => {
      const { db, a } = await seed();
      const results = await Promise.allSettled(
        ['0001', '0002', '0003', '0004'].map((id, i) =>
          db.insert(tenantCscs).values(csc(a, id, 'test', (i % 3) + 1)),
        ),
      );
      expect(results.filter((r) => r.status === 'fulfilled').length).toBeLessThanOrEqual(2);
      expect(await db.select().from(tenantCscs)).toHaveLength(2);
    },
  );
});
