import { describe, expect, it, vi } from 'vitest';
import { EkuatiaSolveQuota } from './ekuatia-solve-quota.js';
import { InMemorySolveUsageStore } from './testing/in-memory-reception.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

function harness(tenantCap: number, globalCap: number, now = new Date('2026-11-16T10:00:00.000Z')) {
  const store = new InMemorySolveUsageStore();
  const log = vi.fn();
  const clock = { now };
  const quota = new EkuatiaSolveQuota({
    store,
    tenantCap,
    globalCap,
    now: () => clock.now,
    log,
  });
  return { store, log, clock, quota };
}

describe('EkuatiaSolveQuota', () => {
  it('reserves up to the per-tenant cap and then refuses with the seconds to the next UTC day', async () => {
    const { quota } = harness(2, 100, new Date('2026-11-16T23:00:00.000Z'));
    expect(await quota.reserve(TENANT)).toMatchObject({ ok: true, usageDate: '2026-11-16' });
    expect((await quota.reserve(TENANT)).ok).toBe(true);
    expect(await quota.reserve(TENANT)).toEqual({
      ok: false,
      scope: 'tenant',
      cap: 2,
      retryAfterSeconds: 3600,
    });
  });

  it('refuses every tenant once the global cap is used, and says so', async () => {
    const { quota } = harness(10, 2);
    expect((await quota.reserve(TENANT)).ok).toBe(true);
    expect((await quota.reserve(OTHER)).ok).toBe(true);
    expect(await quota.reserve(TENANT)).toMatchObject({ ok: false, scope: 'global', cap: 2 });
  });

  it('a refused tenant-cap reservation does not consume the global cap', async () => {
    const { quota, store } = harness(1, 5);
    await quota.reserve(TENANT);
    await quota.reserve(TENANT);
    expect(store.globalUsed('2026-11-16')).toBe(1);
  });

  it('a refused global-cap reservation does not consume the tenant cap', async () => {
    const { quota, store } = harness(5, 1);
    await quota.reserve(OTHER);
    await quota.reserve(TENANT);
    expect(store.tenantUsed(TENANT, '2026-11-16')).toBe(0);
  });

  it('counts per UTC day', async () => {
    const { quota, clock } = harness(1, 1);
    expect((await quota.reserve(TENANT)).ok).toBe(true);
    expect((await quota.reserve(TENANT)).ok).toBe(false);
    clock.now = new Date('2026-11-17T00:00:00.000Z');
    expect((await quota.reserve(TENANT)).ok).toBe(true);
  });

  it('gives both slots back on release, once, on the day they were taken', async () => {
    const { quota, store, clock } = harness(1, 1);
    const first = await quota.reserve(TENANT);
    if (!first.ok) throw new Error('expected a reservation');
    clock.now = new Date('2026-11-17T01:00:00.000Z');
    await first.release();
    await first.release();
    expect(store.tenantUsed(TENANT, '2026-11-16')).toBe(0);
    expect(store.globalUsed('2026-11-16')).toBe(0);
  });

  it('release by day is available to the worker and never throws', async () => {
    const { quota, store } = harness(1, 1);
    await quota.reserve(TENANT);
    store.releaseFails = true;
    await expect(quota.releaseByDay(TENANT, '2026-11-16')).resolves.toBeUndefined();
    store.releaseFails = false;
    await quota.releaseByDay(TENANT, '2026-11-16');
    expect(store.tenantUsed(TENANT, '2026-11-16')).toBe(0);
  });

  it('logs ids and counts only', async () => {
    const { quota, log } = harness(1, 1);
    await quota.reserve(TENANT);
    await quota.reserve(TENANT);
    const dump = JSON.stringify(log.mock.calls);
    expect(dump).toContain(TENANT);
    expect(log).toHaveBeenCalledTimes(2);
  });

  it.each([
    [0, 1],
    [1, 0],
    [1.5, 1],
  ])('rejects caps %j', (tenantCap, globalCap) => {
    expect(() => harness(tenantCap, globalCap)).toThrow(RangeError);
  });
});
