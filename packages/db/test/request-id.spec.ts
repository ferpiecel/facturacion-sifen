import { afterEach, describe, expect, it } from 'vitest';
import type { DatabaseHandle } from '../src/client.js';
import { nextRequestId } from '../src/request-id.js';
import { tenants } from '../src/schema.js';
import { withTenantTransaction } from '../src/tenant-transaction.js';
import { createTestDatabase } from './support/harness.js';

/** Spec: HU-E4-03. `dId` (SIFEN request id, 1..15 digits) sequential per tenant and environment. */
describe('nextRequestId (dId)', () => {
  let handle: DatabaseHandle | undefined;

  async function seed() {
    const testHandle = await createTestDatabase();
    handle = testHandle;
    const { db } = testHandle;
    const [a, b] = await db
      .insert(tenants)
      .values([{ name: 'Tenant A' }, { name: 'Tenant B' }])
      .returning();
    return { db, tenantA: a.id, tenantB: b.id };
  }

  afterEach(async () => {
    await handle?.close();
    handle = undefined;
  });

  const next = (
    db: DatabaseHandle['db'],
    tenantId: string,
    environment: 'test' | 'production' = 'test',
  ) => withTenantTransaction(db, tenantId, (tx) => nextRequestId(tx, tenantId, environment));

  it('starts at 1 and increments sequentially', async () => {
    const { db, tenantA } = await seed();
    expect([await next(db, tenantA), await next(db, tenantA), await next(db, tenantA)]).toEqual([
      1n,
      2n,
      3n,
    ]);
  });

  it('keeps an independent sequence per tenant', async () => {
    const { db, tenantA, tenantB } = await seed();
    expect(await next(db, tenantA)).toBe(1n);
    expect(await next(db, tenantA)).toBe(2n);
    expect(await next(db, tenantB)).toBe(1n);
  });

  it('does not burn a value when the transaction rolls back', async () => {
    const { db, tenantA } = await seed();
    await expect(
      withTenantTransaction(db, tenantA, async (tx) => {
        expect(await nextRequestId(tx, tenantA, 'test')).toBe(1n);
        throw new Error('rolled back');
      }),
    ).rejects.toThrow('rolled back');
    expect(await next(db, tenantA)).toBe(1n);
  });

  it('issues distinct consecutive values under concurrency', async () => {
    const { db, tenantA } = await seed();
    const values = await Promise.all(Array.from({ length: 20 }, () => next(db, tenantA)));
    expect([...values].sort((x, y) => Number(x - y))).toEqual(
      Array.from({ length: 20 }, (_, i) => BigInt(i + 1)),
    );
  });
});
