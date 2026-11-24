import {
  createPgliteDatabase,
  receptionEkuatiaGlobalUsage,
  receptionEkuatiaSolveUsage,
  tenants,
  type DatabaseHandle,
} from '@sifen/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDrizzleEkuatiaSolveUsageStore } from './drizzle-ekuatia-solve-usage-store.js';

const DAY = '2026-11-16';

/** Spec: reception R6.3. Paid-solve counters per tenant and global, all or nothing. */
describe('DrizzleEkuatiaSolveUsageStore', () => {
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

  async function counters(tenantId: string, day = DAY) {
    const tenant = await handle.db.select().from(receptionEkuatiaSolveUsage);
    const global = await handle.db.select().from(receptionEkuatiaGlobalUsage);
    return {
      tenant: tenant.find((r) => r.tenantId === tenantId && r.usageDate === day)?.used ?? 0,
      global: global.find((r) => r.usageDate === day)?.used ?? 0,
    };
  }

  it('takes a slot in both counters and refuses at the tenant cap, changing nothing', async () => {
    const store = createDrizzleEkuatiaSolveUsageStore(handle.db);
    const caps = { tenant: 2, global: 10 };
    expect(await store.tryConsume(tenantA, DAY, caps)).toEqual({ ok: true });
    expect(await store.tryConsume(tenantA, DAY, caps)).toEqual({ ok: true });
    expect(await store.tryConsume(tenantA, DAY, caps)).toEqual({ ok: false, scope: 'tenant' });
    expect(await counters(tenantA)).toEqual({ tenant: 2, global: 2 });
  });

  it('refuses at the global cap and rolls the tenant increment back', async () => {
    const store = createDrizzleEkuatiaSolveUsageStore(handle.db);
    const caps = { tenant: 5, global: 2 };
    await store.tryConsume(tenantA, DAY, caps);
    await store.tryConsume(tenantB, DAY, caps);
    expect(await store.tryConsume(tenantA, DAY, caps)).toEqual({ ok: false, scope: 'global' });
    expect(await counters(tenantA)).toEqual({ tenant: 1, global: 2 });
  });

  it('never overshoots either cap under concurrent calls', async () => {
    const store = createDrizzleEkuatiaSolveUsageStore(handle.db);
    const results = await Promise.all(
      Array.from({ length: 12 }, () => store.tryConsume(tenantA, DAY, { tenant: 5, global: 50 })),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(5);
    expect(await counters(tenantA)).toEqual({ tenant: 5, global: 5 });
  });

  it('keeps tenants and days apart in the tenant counter', async () => {
    const store = createDrizzleEkuatiaSolveUsageStore(handle.db);
    const caps = { tenant: 1, global: 10 };
    expect((await store.tryConsume(tenantA, DAY, caps)).ok).toBe(true);
    expect((await store.tryConsume(tenantA, DAY, caps)).ok).toBe(false);
    expect((await store.tryConsume(tenantB, DAY, caps)).ok).toBe(true);
    expect((await store.tryConsume(tenantA, '2026-11-17', caps)).ok).toBe(true);
  });

  it('release gives one slot back in both counters and never goes below zero', async () => {
    const store = createDrizzleEkuatiaSolveUsageStore(handle.db);
    await store.release(tenantA, DAY);
    expect(await counters(tenantA)).toEqual({ tenant: 0, global: 0 });
    await store.tryConsume(tenantA, DAY, { tenant: 1, global: 1 });
    await store.release(tenantA, DAY);
    await store.release(tenantA, DAY);
    expect(await counters(tenantA)).toEqual({ tenant: 0, global: 0 });
    expect((await store.tryConsume(tenantA, DAY, { tenant: 1, global: 1 })).ok).toBe(true);
  });
});
