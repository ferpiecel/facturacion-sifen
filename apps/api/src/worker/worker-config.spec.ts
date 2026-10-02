import { describe, expect, it } from 'vitest';
import { loadWorkerConfig, WorkerConfigError } from './worker-config.js';

const base = { REDIS_URL: 'redis://:s3cret@localhost:6379/0' };

/** Spec: HU-E6-02 (S5d). Environment of the transmission worker process. */
describe('loadWorkerConfig', () => {
  it('requires REDIS_URL and never echoes it', () => {
    expect(() => loadWorkerConfig({})).toThrow(new WorkerConfigError('REDIS_URL is required'));
    expect(() => loadWorkerConfig({ REDIS_URL: 'http://s3cret@host' })).toThrow(
      'REDIS_URL must be a redis:// or rediss:// URL',
    );
    expect(() => loadWorkerConfig({ REDIS_URL: 'not a url s3cret' })).toThrow(
      'REDIS_URL must be a redis:// or rediss:// URL',
    );
    try {
      loadWorkerConfig({ REDIS_URL: 'not a url s3cret' });
    } catch (error) {
      expect(String(error)).not.toContain('s3cret');
    }
  });

  it('defaults to a 60 s cycle, 4 concurrent tenants and a 5 min run lock', () => {
    expect(loadWorkerConfig(base)).toEqual({
      redisUrl: base.REDIS_URL,
      cycleIntervalMs: 60_000,
      concurrency: 4,
      lockTtlMs: 300_000,
    });
  });

  it('reads the tunables and bounds them', () => {
    expect(
      loadWorkerConfig({
        ...base,
        TRANSMISSION_CYCLE_INTERVAL_MS: '30000',
        WORKER_CONCURRENCY: '8',
        TENANT_RUN_LOCK_TTL_MS: '120000',
      }),
    ).toMatchObject({ cycleIntervalMs: 30_000, concurrency: 8, lockTtlMs: 120_000 });
    for (const [name, value] of [
      ['TRANSMISSION_CYCLE_INTERVAL_MS', '999'],
      ['TRANSMISSION_CYCLE_INTERVAL_MS', 'abc'],
      ['WORKER_CONCURRENCY', '0'],
      ['WORKER_CONCURRENCY', '33'],
      ['TENANT_RUN_LOCK_TTL_MS', '1.5'],
    ] as const) {
      expect(() => loadWorkerConfig({ ...base, [name]: value })).toThrow(
        new WorkerConfigError(`${name} is out of range`),
      );
    }
  });
});
