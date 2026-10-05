import { randomUUID } from 'node:crypto';
import { Queue } from 'bullmq';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createRedisConnection,
  createTenantScheduleStore,
  createTransmissionWorker,
  createWebhookDeliveryQueue,
  createWebhookDeliveryWorker,
  createWebhookScheduleStore,
} from './queue.js';
import { startTransmissionWorker } from './start-transmission-worker.js';
import { createRedisTenantRunLock } from './tenant-run-lock.js';

const REDIS_URL = process.env.REDIS_URL;

const until = async (condition: () => boolean, ms = 8000) => {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for the condition');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

/**
 * Spec: HU-E6-02 (S5d). Runs against a real Redis only when `REDIS_URL` is set (CI's `worker-redis`
 * job; locally `docker compose up -d redis` then `REDIS_URL=redis://localhost:6379 pnpm --filter
 * @sifen/api test src/worker/queue.integration`). Skipped otherwise, so unit runs stay Redis-free.
 */
describe.skipIf(!REDIS_URL)('BullMQ transmission queue (real Redis)', () => {
  const cleanup: (() => Promise<unknown>)[] = [];
  afterEach(async () => {
    for (const close of cleanup.splice(0).reverse()) await close();
  });

  const open = () => {
    const prefix = `test-${randomUUID()}`;
    const connection = createRedisConnection(REDIS_URL ?? '');
    cleanup.push(() => connection.quit());
    return { prefix, connection };
  };

  it('keeps one repeatable schedule per tenant and removes the ones that are gone', async () => {
    const { prefix, connection } = open();
    const queue = new Queue('lote-build', { connection, prefix });
    cleanup.push(() => queue.close());
    const store = createTenantScheduleStore(queue);

    await store.upsert('t1', 60_000);
    await store.upsert('t1', 30_000); // idempotent: still one
    await store.upsert('t2', 60_000);
    expect([...(await store.list())].sort()).toEqual(['t1', 't2']);

    await store.remove('t1');
    expect(await store.list()).toEqual(['t2']);
  });

  it('delivers each tenant scheduled job to the processor with its tenant id', async () => {
    const { prefix, connection } = open();
    const queue = new Queue('lote-build', { connection, prefix });
    cleanup.push(() => queue.close());
    const seen: string[] = [];
    const worker = createTransmissionWorker({
      connection,
      prefix,
      concurrency: 2,
      process: (data) => {
        seen.push(data.tenantId);
        return Promise.resolve();
      },
    });
    cleanup.push(() => worker.close());

    await createTenantScheduleStore(queue).upsert('t1', 100);
    await until(() => seen.length >= 2);

    expect(new Set(seen)).toEqual(new Set(['t1']));
  });

  it('shares the tenant run lock between connections', async () => {
    const a = open().connection;
    const b = createRedisConnection(REDIS_URL ?? '');
    cleanup.push(() => b.quit());
    const lockA = createRedisTenantRunLock(a, { ttlMs: 10_000 });
    const lockB = createRedisTenantRunLock(b, { ttlMs: 10_000 });

    const lease = await lockA.acquire('t-lock');
    expect(await lockB.acquire('t-lock')).toBeNull();
    await lease?.release();
    const second = await lockB.acquire('t-lock');
    expect(second).not.toBeNull();
    await second?.release();
  });

  it('runs the whole worker lifecycle: schedules tenants, processes their jobs and stops', async () => {
    const { prefix, connection } = open();
    const queue = new Queue('lote-build', { connection, prefix });
    cleanup.push(() => queue.close());
    const seen = new Set<string>();
    const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };

    const running = await startTransmissionWorker({
      cycleIntervalMs: 100,
      reconcileEveryMs: 60_000,
      directory: { tenantIds: () => Promise.resolve(['a', 'b']) },
      schedules: createTenantScheduleStore(queue),
      process: (data) => {
        seen.add(data.tenantId);
        return Promise.resolve();
      },
      createWorker: (process) =>
        createTransmissionWorker({ connection, prefix, concurrency: 2, process }),
      logger: quiet,
    });
    await until(() => seen.size === 2);
    await running.stop();

    expect(seen).toEqual(new Set(['a', 'b']));
  });

  /** Spec: HU-E11-01. The `webhook-delivery` queue is separate from `lote-build` and keyed per tenant. */
  it('keeps one webhook delivery schedule per tenant on its own queue', async () => {
    const { prefix, connection } = open();
    const transmission = new Queue('lote-build', { connection, prefix });
    cleanup.push(() => transmission.close());
    const queue = createWebhookDeliveryQueue(connection, { error: () => undefined }, prefix);
    cleanup.push(() => queue.close());
    const store = createWebhookScheduleStore(queue);

    await store.upsert('t1', 30_000);
    await store.upsert('t1', 10_000); // idempotent: still one
    await store.upsert('t2', 30_000);
    expect([...(await store.list())].sort()).toEqual(['t1', 't2']);
    expect(await createTenantScheduleStore(transmission).list()).toEqual([]);

    await store.remove('t1');
    expect(await store.list()).toEqual(['t2']);
  });

  it('delivers each tenant webhook job to the processor with its tenant id', async () => {
    const { prefix, connection } = open();
    const queue = createWebhookDeliveryQueue(connection, { error: () => undefined }, prefix);
    cleanup.push(() => queue.close());
    const seen: string[] = [];
    const worker = createWebhookDeliveryWorker({
      connection,
      prefix,
      concurrency: 2,
      process: (data) => {
        seen.push(data.tenantId);
        return Promise.resolve();
      },
    });
    cleanup.push(() => worker.close());

    await createWebhookScheduleStore(queue).upsert('t1', 100);
    await until(() => seen.length >= 2);

    expect(new Set(seen)).toEqual(new Set(['t1']));
  });
});
