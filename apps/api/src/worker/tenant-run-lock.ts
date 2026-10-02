import { randomUUID } from 'node:crypto';

/** The slice of an ioredis client the lock uses. */
export interface RedisLockClient {
  set(key: string, value: string, px: 'PX', ttlMs: number, nx: 'NX'): Promise<'OK' | null>;
  eval(script: string, numKeys: number, key: string, token: string): Promise<unknown>;
}

/** Cross-process mutual exclusion per tenant: at most one transmission cycle runs for a tenant. */
export interface TenantRunLock {
  /** Resolves a release function, or null when the tenant is already being processed. */
  acquire(tenantId: string): Promise<(() => Promise<void>) | null>;
}

// Delete only if the key still holds our token: after a ttl expiry someone else may own it.
const RELEASE_SCRIPT =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

export function createRedisTenantRunLock(
  redis: RedisLockClient,
  { ttlMs, token = randomUUID }: { ttlMs: number; token?: () => string },
): TenantRunLock {
  return {
    async acquire(tenantId) {
      const key = `sifen:transmission-cycle:lock:${tenantId}`;
      const mine = token();
      if ((await redis.set(key, mine, 'PX', ttlMs, 'NX')) !== 'OK') return null;
      return async () => {
        await redis.eval(RELEASE_SCRIPT, 1, key, mine);
      };
    },
  };
}
