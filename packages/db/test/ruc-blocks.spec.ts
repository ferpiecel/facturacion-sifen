import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { DatabaseHandle } from '../src/client.js';
import { rucBlocks, tenants } from '../src/schema.js';
import { withTenantTransaction } from '../src/tenant-transaction.js';
import { createTestDatabase } from './support/harness.js';

const SINCE = new Date('2026-10-01T12:00:00Z');
const UNTIL = new Date('2026-10-01T12:30:00Z');

async function causeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    const cause = (error as { cause?: unknown }).cause;
    return cause instanceof Error ? cause.message : String(cause);
  }
  return expect.unreachable('expected the query to reject');
}

/** Spec: HU-E6-05 (DB part). One row per pause of a tenant's sends after SIFEN blocked its RUC. */
describe('ruc_blocks', () => {
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

  const block = (tenantId: string, overrides: Partial<typeof rucBlocks.$inferInsert> = {}) => ({
    tenantId,
    environment: 'test' as const,
    blockedAt: SINCE,
    blockedUntil: UNTIL,
    reason: 'RUC bloqueado',
    ...overrides,
  });

  it('lets a tenant record and read its own pause', async () => {
    const { db, a } = await seed();
    await withTenantTransaction(db, a, (tx) => tx.insert(rucBlocks).values(block(a)));
    const rows = await withTenantTransaction(db, a, (tx) => tx.select().from(rucBlocks));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tenantId: a, reason: 'RUC bloqueado', blockedUntil: UNTIL });
  });

  it('hides a pause from other tenants and refuses to write one for another tenant', async () => {
    const { db, a, b } = await seed();
    await withTenantTransaction(db, a, (tx) => tx.insert(rucBlocks).values(block(a)));
    expect(await withTenantTransaction(db, b, (tx) => tx.select().from(rucBlocks))).toEqual([]);
    expect(
      await causeOf(withTenantTransaction(db, b, (tx) => tx.insert(rucBlocks).values(block(a)))),
    ).toMatch(/row-level security/);
  });

  it('is history: a tenant can neither rewrite nor delete a pause', async () => {
    const { db, a } = await seed();
    await withTenantTransaction(db, a, (tx) => tx.insert(rucBlocks).values(block(a)));
    expect(
      await causeOf(
        withTenantTransaction(db, a, (tx) =>
          tx.update(rucBlocks).set({ blockedUntil: SINCE }).where(eq(rucBlocks.tenantId, a)),
        ),
      ),
    ).toMatch(/permission denied/);
    expect(
      await causeOf(
        withTenantTransaction(db, a, (tx) => tx.delete(rucBlocks).where(eq(rucBlocks.tenantId, a))),
      ),
    ).toMatch(/permission denied/);
  });

  it('refuses a pause that ends before it starts', async () => {
    const { db, a } = await seed();
    expect(
      await causeOf(
        withTenantTransaction(db, a, (tx) =>
          tx.insert(rucBlocks).values(block(a, { blockedUntil: SINCE })),
        ),
      ),
    ).toMatch(/ruc_blocks_window/);
  });

  it('bounds the stored reason', async () => {
    const { db, a } = await seed();
    expect(
      await causeOf(
        withTenantTransaction(db, a, (tx) =>
          tx.insert(rucBlocks).values(block(a, { reason: 'x'.repeat(501) })),
        ),
      ),
    ).toMatch(/ruc_blocks_reason_length/);
  });
});
