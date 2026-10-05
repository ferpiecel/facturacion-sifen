import { describe, expect, it } from 'vitest';
import { createRedisTenantRunLock, type RedisLockClient } from './tenant-run-lock.js';

/** A minimal in-memory Redis: SET NX PX, the compare-and-delete script and the compare-and-extend one. */
function fakeRedis() {
  const store = new Map<string, string>();
  const ttls: number[] = [];
  const renewals: number[] = [];
  let failRenewals = false;
  const client: RedisLockClient = {
    set: (key, value, _px, ttl) => {
      ttls.push(ttl);
      if (store.has(key)) return Promise.resolve(null);
      store.set(key, value);
      return Promise.resolve('OK');
    },
    eval: (script, _keys, key, token, ttl) => {
      if (script.includes('pexpire')) {
        if (failRenewals) return Promise.reject(new Error('redis down'));
        if (store.get(key) !== token) return Promise.resolve(0);
        renewals.push(Number(ttl));
        return Promise.resolve(1);
      }
      if (store.get(key) === token) {
        store.delete(key);
        return Promise.resolve(1);
      }
      return Promise.resolve(0);
    },
  };
  return { client, store, ttls, renewals, failRenewals: () => (failRenewals = true) };
}

/** Timers the test fires by hand. */
function manualTimers() {
  let tick: (() => void) | undefined;
  const events: string[] = [];
  return {
    timers: {
      setInterval: (fn: () => void, ms: number) => {
        events.push(`every:${String(ms)}`);
        tick = fn;
        return 1 as unknown as NodeJS.Timeout;
      },
      clearInterval: () => {
        events.push('cleared');
        tick = undefined;
      },
    },
    fire: async () => {
      tick?.();
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
    events,
  };
}

/** Spec: HU-E6-02 (S5e). One transmission cycle per tenant at a time, across worker processes. */
describe('createRedisTenantRunLock', () => {
  it('lets one holder in per tenant and frees the tenant on release', async () => {
    const { client, ttls } = fakeRedis();
    const lock = createRedisTenantRunLock(client, { ttlMs: 1234, timers: manualTimers().timers });

    const first = await lock.acquire('t1');
    expect(first).not.toBeNull();
    expect(await lock.acquire('t1')).toBeNull();
    expect(await lock.acquire('t2')).not.toBeNull();
    expect(ttls[0]).toBe(1234);

    await first?.release();
    expect(await lock.acquire('t1')).not.toBeNull();
  });

  it('never releases a lock someone else took after the ttl expired', async () => {
    const { client, store } = fakeRedis();
    const lock = createRedisTenantRunLock(client, { ttlMs: 1000, timers: manualTimers().timers });
    const first = await lock.acquire('t1');

    store.clear(); // the key expired
    const next = await lock.acquire('t1');
    await first?.release();

    expect(await lock.acquire('t1')).toBeNull(); // still held by `next`
    await next?.release();
  });

  it('extends the lock every third of the ttl while held, and stops on release', async () => {
    const { client, renewals } = fakeRedis();
    const clock = manualTimers();
    const lock = createRedisTenantRunLock(client, { ttlMs: 30_000, timers: clock.timers });

    const lease = await lock.acquire('t1');
    await clock.fire();
    await clock.fire();
    expect(clock.events).toEqual(['every:10000']);
    expect(renewals).toEqual([30_000, 30_000]);
    expect(lease?.signal.aborted).toBe(false);

    await lease?.release();
    expect(clock.events).toEqual(['every:10000', 'cleared']);
  });

  it('aborts the lease signal when the lock was lost or renewing fails', async () => {
    const lost = fakeRedis();
    const lostClock = manualTimers();
    const lease = await createRedisTenantRunLock(lost.client, {
      ttlMs: 30_000,
      timers: lostClock.timers,
    }).acquire('t1');
    lost.store.clear(); // expired and not renewed in time
    await lostClock.fire();
    expect(lease?.signal.aborted).toBe(true);
    expect(lostClock.events).toContain('cleared');

    const down = fakeRedis();
    const downClock = manualTimers();
    const other = await createRedisTenantRunLock(down.client, {
      ttlMs: 30_000,
      timers: downClock.timers,
    }).acquire('t1');
    down.failRenewals();
    await downClock.fire();
    expect(other?.signal.aborted).toBe(true);
  });
});
