import { randomUUID } from 'node:crypto';

/** The slice of an ioredis client the lock uses. */
export interface RedisLockClient {
  set(key: string, value: string, px: 'PX', ttlMs: number, nx: 'NX'): Promise<'OK' | null>;
  eval(
    script: string,
    numKeys: number,
    key: string,
    ...args: (string | number)[]
  ): Promise<unknown>;
}

/** A held tenant lock, kept alive while the cycle runs. */
export interface RunLease {
  /** Aborts if the lock could no longer be extended (expired, taken over, Redis unreachable). */
  readonly signal: AbortSignal;
  /** Stops extending and frees the lock, only if it is still ours. */
  release(): Promise<void>;
}

/** Cross-process mutual exclusion per tenant: at most one transmission cycle runs for a tenant. */
export interface TenantRunLock {
  /** Resolves a lease, or null when the tenant is already being processed. */
  acquire(tenantId: string): Promise<RunLease | null>;
}

// Both scripts act only while the key still holds our token: after a ttl expiry someone else may own it.
const RELEASE_SCRIPT =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";
const RENEW_SCRIPT =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end";

export interface RedisTenantRunLockOptions {
  readonly ttlMs: number;
  readonly token?: () => string;
  readonly timers?: {
    setInterval(fn: () => void, ms: number): NodeJS.Timeout;
    clearInterval(timer: NodeJS.Timeout): void;
  };
}

/**
 * The ttl only bounds how long a crashed holder blocks its tenant: while a cycle runs the lock is
 * extended every third of the ttl, so a long cycle never loses it silently. If an extension fails the
 * lease signal aborts and the cycle stops between units of work (the claims make that safe).
 */
export function createRedisTenantRunLock(
  redis: RedisLockClient,
  { ttlMs, token = randomUUID, timers = { setInterval, clearInterval } }: RedisTenantRunLockOptions,
): TenantRunLock {
  return {
    async acquire(tenantId) {
      const key = `sifen:transmission-cycle:lock:${tenantId}`;
      const mine = token();
      if ((await redis.set(key, mine, 'PX', ttlMs, 'NX')) !== 'OK') return null;

      const lost = new AbortController();
      const timer = timers.setInterval(
        () => {
          void redis
            .eval(RENEW_SCRIPT, 1, key, mine, ttlMs)
            .then((extended) => extended === 1)
            .catch(() => false)
            .then((ok) => {
              if (ok) return;
              timers.clearInterval(timer);
              lost.abort();
            });
        },
        Math.floor(ttlMs / 3),
      );

      return {
        signal: lost.signal,
        async release() {
          timers.clearInterval(timer);
          await redis.eval(RELEASE_SCRIPT, 1, key, mine);
        },
      };
    },
  };
}
