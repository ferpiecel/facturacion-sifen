/** Invalid or missing environment for the worker. Messages never carry the offending value (REDIS_URL holds a password). */
export class WorkerConfigError extends Error {
  override name = 'WorkerConfigError';
}

export interface WorkerConfig {
  readonly redisUrl: string;
  /** How often each tenant's transmission cycle runs. */
  readonly cycleIntervalMs: number;
  /** Tenants processed at once by one worker process. */
  readonly concurrency: number;
  /** How long a tenant's run lock lives if the process dies mid-cycle. */
  readonly lockTtlMs: number;
}

function integer(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new WorkerConfigError(`${name} is out of range`);
  }
  return value;
}

/** Reads the worker's settings (README "Variables de entorno"); fails closed without Redis. */
export function loadWorkerConfig(env: NodeJS.ProcessEnv): WorkerConfig {
  const redisUrl = env.REDIS_URL;
  if (!redisUrl) throw new WorkerConfigError('REDIS_URL is required');
  let protocol: string;
  try {
    ({ protocol } = new URL(redisUrl));
  } catch {
    protocol = '';
  }
  if (protocol !== 'redis:' && protocol !== 'rediss:') {
    throw new WorkerConfigError('REDIS_URL must be a redis:// or rediss:// URL');
  }
  return {
    redisUrl,
    cycleIntervalMs: integer(env, 'TRANSMISSION_CYCLE_INTERVAL_MS', 60_000, 5_000, 3_600_000),
    concurrency: integer(env, 'WORKER_CONCURRENCY', 4, 1, 32),
    lockTtlMs: integer(env, 'TENANT_RUN_LOCK_TTL_MS', 300_000, 10_000, 3_600_000),
  };
}
