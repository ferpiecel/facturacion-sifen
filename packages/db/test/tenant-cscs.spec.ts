import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { DatabaseHandle } from '../src/client.js';
import { tenantCscs, tenants } from '../src/schema.js';
import { withTenantTransaction } from '../src/tenant-transaction.js';
import { createTestDatabase } from './support/harness.js';

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

  const csc = (tenantId: string, idCsc: string, environment: 'test' | 'production' = 'test') => ({
    tenantId,
    environment,
    idCsc,
    sealed: SEALED,
  });

  it('has no plaintext column', async () => {
    const { db } = await seed();
    const columns = Object.keys(tenantCscs);
    expect(columns).toContain('sealed');
    expect(columns.some((c) => /^(csc|code|secret|plain)/i.test(c))).toBe(false);
    expect(db).toBeDefined();
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
    const message = await causeOf(db.insert(tenantCscs).values(csc(a, '0003')));
    expect(message).toContain('at most 2 CSC per environment');
    await db.insert(tenantCscs).values(csc(a, '0003', 'production'));
    expect(await db.select().from(tenantCscs).where(eq(tenantCscs.tenantId, a))).toHaveLength(3);
  });

  it('isolates reads and writes by tenant through RLS', async () => {
    const { db, a, b } = await seed();
    await db.insert(tenantCscs).values([csc(a, '0001'), csc(b, '0001')]);

    const seen = await withTenantTransaction(db, a, (tx) => tx.select().from(tenantCscs));
    expect(seen.map((r) => r.tenantId)).toEqual([a]);

    const message = await causeOf(
      withTenantTransaction(db, a, (tx) => tx.insert(tenantCscs).values(csc(b, '0002'))),
    );
    expect(message).toContain('row-level security policy');
  });
});
