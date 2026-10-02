import { describe, expect, it } from 'vitest';
import { createRedisTenantRunLock, type RedisLockClient } from './tenant-run-lock.js';

/** A minimal in-memory Redis: SET NX PX and the compare-and-delete script. */
function fakeRedis() {
  const store = new Map<string, string>();
  const ttls: number[] = [];
  const client: RedisLockClient = {
    set: (key, value, _px, ttl) => {
      ttls.push(ttl);
      if (store.has(key)) return Promise.resolve(null);
      store.set(key, value);
      return Promise.resolve('OK');
    },
    eval: (_script, _keys, key, token) => {
      if (store.get(key) === token) {
        store.delete(key);
        return Promise.resolve(1);
      }
      return Promise.resolve(0);
    },
  };
  return { client, store, ttls };
}

/** Spec: HU-E6-02 (S5e). One transmission cycle per tenant at a time, across worker processes. */
describe('createRedisTenantRunLock', () => {
  it('lets one holder in per tenant and frees the tenant on release', async () => {
    const { client, ttls } = fakeRedis();
    const lock = createRedisTenantRunLock(client, { ttlMs: 1234 });

    const first = await lock.acquire('t1');
    expect(first).not.toBeNull();
    expect(await lock.acquire('t1')).toBeNull();
    expect(await lock.acquire('t2')).not.toBeNull();
    expect(ttls[0]).toBe(1234);

    await first?.();
    expect(await lock.acquire('t1')).not.toBeNull();
  });

  it('never releases a lock someone else took after the ttl expired', async () => {
    const { client, store } = fakeRedis();
    const lock = createRedisTenantRunLock(client, { ttlMs: 1000 });
    const release = await lock.acquire('t1');

    store.clear(); // the key expired
    const next = await lock.acquire('t1');
    await release?.();

    expect(await lock.acquire('t1')).toBeNull(); // still held by `next`
    await next?.();
  });
});
