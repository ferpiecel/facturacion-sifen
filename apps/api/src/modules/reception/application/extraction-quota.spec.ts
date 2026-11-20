import { describe, expect, it, vi } from 'vitest';
import { ExtractionQuota, usageDateOf } from './extraction-quota.js';
import { InMemoryExtractionUsageStore } from './testing/in-memory-reception.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

function harness(dailyCap: number, now = new Date('2026-11-16T10:00:00.000Z')) {
  const store = new InMemoryExtractionUsageStore();
  const log = vi.fn();
  const clock = { now };
  const quota = new ExtractionQuota({ store, dailyCap, now: () => clock.now, log });
  return { store, log, clock, quota };
}

describe('usageDateOf', () => {
  it('is the UTC calendar day', () => {
    expect(usageDateOf(new Date('2026-11-16T23:59:59.999Z'))).toBe('2026-11-16');
    expect(usageDateOf(new Date('2026-11-17T00:00:00.000Z'))).toBe('2026-11-17');
  });
});

describe('ExtractionQuota', () => {
  it('reserves up to the cap and then refuses with the seconds until the next UTC day', async () => {
    const { quota } = harness(2, new Date('2026-11-16T23:00:00.000Z'));
    expect(await quota.reserve(TENANT)).toMatchObject({ ok: true, used: 1, cap: 2 });
    expect(await quota.reserve(TENANT)).toMatchObject({ ok: true, used: 2, cap: 2 });
    expect(await quota.reserve(TENANT)).toEqual({ ok: false, cap: 2, retryAfterSeconds: 3600 });
  });

  it('counts per tenant and per UTC day', async () => {
    const { quota, clock } = harness(1);
    expect((await quota.reserve(TENANT)).ok).toBe(true);
    expect((await quota.reserve(TENANT)).ok).toBe(false);
    expect((await quota.reserve(OTHER)).ok).toBe(true);
    clock.now = new Date('2026-11-17T00:00:00.000Z');
    expect((await quota.reserve(TENANT)).ok).toBe(true);
  });

  it('gives the slot back on release, once, on the day it was taken', async () => {
    const { quota, clock } = harness(1);
    const first = await quota.reserve(TENANT);
    if (!first.ok) throw new Error('expected a reservation');
    clock.now = new Date('2026-11-16T23:59:00.000Z');
    await first.release();
    await first.release();
    expect(await quota.reserve(TENANT)).toMatchObject({ ok: true, used: 1 });
    expect((await quota.reserve(TENANT)).ok).toBe(false);
  });

  it('a failing release never throws', async () => {
    const { quota, store } = harness(1);
    const first = await quota.reserve(TENANT);
    if (!first.ok) throw new Error('expected a reservation');
    store.releaseFails = true;
    await expect(first.release()).resolves.toBeUndefined();
  });

  it('logs ids and counts only', async () => {
    const { quota, log } = harness(1);
    await quota.reserve(TENANT);
    await quota.reserve(TENANT);
    expect(log.mock.calls).toEqual([
      ['reception extraction usage', { tenantId: TENANT, used: 1, cap: 1 }],
      ['reception extraction quota exceeded', { tenantId: TENANT, cap: 1 }],
    ]);
  });
});
