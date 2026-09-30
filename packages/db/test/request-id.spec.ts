import { afterEach, describe, expect, it } from 'vitest';
import type { DatabaseHandle } from '../src/client.js';
import { eq } from 'drizzle-orm';
import { MAX_REQUEST_ID, nextRequestId, RequestIdExhaustedError } from '../src/request-id.js';
import { tenantRequestSequences, tenants } from '../src/schema.js';
import { withTenantTransaction } from '../src/tenant-transaction.js';
import { createTestDatabase } from './support/harness.js';

async function causeMessage(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    const cause = (error as { cause?: unknown }).cause;
    return cause instanceof Error ? cause.message : String(error);
  }
  return expect.unreachable('expected the query to reject');
}

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

  it('rejects tenant-role attempts to rewind, skip or re-key the counter', async () => {
    const { db, tenantA, tenantB } = await seed();
    await next(db, tenantA);
    await next(db, tenantA);
    const update = (set: Partial<typeof tenantRequestSequences.$inferInsert>) =>
      causeMessage(
        withTenantTransaction(db, tenantA, (tx) => tx.update(tenantRequestSequences).set(set)),
      );

    for (const lastValue of [0n, 1n, 2n, 4n]) {
      expect(await update({ lastValue })).toContain('last_value may only advance by 1');
    }
    expect(await update({ environment: 'production' })).toContain('environment must match');
    expect(await update({ tenantId: tenantB })).toContain('key columns are immutable');
    expect(await next(db, tenantA)).toBe(3n);
  });

  it('rejects a sequence for an environment other than the tenant current one', async () => {
    const { db, tenantA } = await seed();
    expect(await causeMessage(next(db, tenantA, 'production'))).toContain(
      "environment must match the tenant's current environment",
    );
  });

  it('throws RequestIdExhaustedError once the 15-digit maximum was issued', async () => {
    const { db, tenantA } = await seed();
    await db
      .insert(tenantRequestSequences)
      .values({ tenantId: tenantA, environment: 'test', lastValue: MAX_REQUEST_ID });

    await expect(next(db, tenantA)).rejects.toBeInstanceOf(RequestIdExhaustedError);
    const rows = await db
      .select()
      .from(tenantRequestSequences)
      .where(eq(tenantRequestSequences.tenantId, tenantA));
    expect(rows.map((row) => row.lastValue)).toEqual([MAX_REQUEST_ID]);
  });
});
