import { createPgliteDatabase, tenants, type DatabaseHandle } from '@sifen/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDrizzleExtractionUsageStore } from './drizzle-extraction-usage-store.js';

const DAY = '2026-11-16';

/** Spec: reception R5.9. The per-tenant daily counter, atomic and under forced RLS. */
describe('DrizzleExtractionUsageStore', () => {
  let handle: DatabaseHandle;
  let tenantA: string;
  let tenantB: string;

  beforeEach(async () => {
    handle = createPgliteDatabase();
    await handle.migrate();
    const rows = await handle.db
      .insert(tenants)
      .values([{ name: 'A' }, { name: 'B' }])
      .returning();
    [tenantA, tenantB] = rows.map((row) => row.id);
  });
  afterEach(async () => {
    await handle.close();
  });

  it('counts up to the cap and then answers null without changing the counter', async () => {
    const store = createDrizzleExtractionUsageStore(handle.db);
    expect(await store.tryConsume(tenantA, DAY, 2)).toBe(1);
    expect(await store.tryConsume(tenantA, DAY, 2)).toBe(2);
    expect(await store.tryConsume(tenantA, DAY, 2)).toBeNull();
    expect(await store.tryConsume(tenantA, DAY, 2)).toBeNull();
    expect(await store.tryConsume(tenantA, DAY, 3)).toBe(3);
  });

  it('never overshoots the cap under concurrent calls', async () => {
    const store = createDrizzleExtractionUsageStore(handle.db);
    const results = await Promise.all(
      Array.from({ length: 12 }, () => store.tryConsume(tenantA, DAY, 5)),
    );
    expect(results.filter((used) => used !== null).sort()).toEqual([1, 2, 3, 4, 5]);
    expect(results.filter((used) => used === null)).toHaveLength(7);
  });

  it('keeps tenants and days apart', async () => {
    const store = createDrizzleExtractionUsageStore(handle.db);
    expect(await store.tryConsume(tenantA, DAY, 1)).toBe(1);
    expect(await store.tryConsume(tenantA, DAY, 1)).toBeNull();
    expect(await store.tryConsume(tenantB, DAY, 1)).toBe(1);
    expect(await store.tryConsume(tenantA, '2026-11-17', 1)).toBe(1);
  });

  it('release gives one slot back and never goes below zero', async () => {
    const store = createDrizzleExtractionUsageStore(handle.db);
    await store.release(tenantA, DAY);
    expect(await store.tryConsume(tenantA, DAY, 1)).toBe(1);
    await store.release(tenantA, DAY);
    await store.release(tenantA, DAY);
    expect(await store.tryConsume(tenantA, DAY, 1)).toBe(1);
    expect(await store.tryConsume(tenantA, DAY, 1)).toBeNull();
  });

  it('rejects a tenant id that is not a UUID before touching SQL', async () => {
    const store = createDrizzleExtractionUsageStore(handle.db);
    await expect(store.tryConsume("x'; drop table tenants;--", DAY, 1)).rejects.toThrow();
  });
});
