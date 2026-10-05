import { describe, expect, it } from 'vitest';
import type { TenantScheduleStore } from './queue.js';
import { startTransmissionWorker } from './start-transmission-worker.js';

function setup(options: { tenants?: string[]; directoryFails?: boolean } = {}) {
  const events: string[] = [];
  const logs: string[] = [];
  let tick: (() => void) | undefined;
  const schedules: TenantScheduleStore = {
    list: () => Promise.resolve([]),
    upsert: (id, every) => {
      events.push(`upsert:${id}:${String(every)}`);
      return Promise.resolve();
    },
    remove: (id) => {
      events.push(`remove:${id}`);
      return Promise.resolve();
    },
  };
  const deps = {
    cycleIntervalMs: 60_000,
    reconcileEveryMs: 300_000,
    directory: {
      tenantIds: () =>
        options.directoryFails
          ? Promise.reject(new Error('db url postgres://u:pw@h'))
          : Promise.resolve(options.tenants ?? ['a', 'b']),
    },
    schedules,
    process: () => Promise.resolve(),
    createWorker: () => ({
      close: () => {
        events.push('worker-closed');
        return Promise.resolve();
      },
    }),
    logger: {
      info: (m: string) => logs.push(m),
      warn: (m: string) => logs.push(m),
      error: (m: string) => logs.push(m),
    },
    timers: {
      setInterval: (fn: () => void, ms: number) => {
        events.push(`interval:${String(ms)}`);
        tick = fn;
        return 1 as unknown as NodeJS.Timeout;
      },
      clearInterval: () => events.push('interval-cleared'),
    },
  };
  return { deps, events, logs, tick: () => tick?.() };
}

function withWebhooks(deps: ReturnType<typeof setup>['deps'], events: string[]) {
  return {
    ...deps,
    webhooks: {
      everyMs: 30_000,
      schedules: {
        list: () => Promise.resolve(['a', 'gone']),
        upsert: (id: string, every: number) => {
          events.push(`wh-upsert:${id}:${String(every)}`);
          return Promise.resolve();
        },
        remove: (id: string) => {
          events.push(`wh-remove:${id}`);
          return Promise.resolve();
        },
      } satisfies TenantScheduleStore,
      createWorker: () => ({
        close: () => {
          events.push('webhook-worker-closed');
          return Promise.resolve();
        },
      }),
    },
  };
}

/** Spec: HU-E6-02 (S5e). Worker lifecycle: schedule every tenant, keep schedules fresh, stop gracefully. */
describe('startTransmissionWorker', () => {
  it('schedules every tenant at the cadence, starts the worker and reconciles periodically', async () => {
    const { deps, events } = setup();

    await startTransmissionWorker(deps);

    expect(events).toEqual(['upsert:a:60000', 'upsert:b:60000', 'interval:300000']);
  });

  it('stops gracefully: no more reconciling, then the worker finishes its running jobs', async () => {
    const { deps, events } = setup();
    const running = await startTransmissionWorker(deps);

    await running.stop();

    expect(events.slice(-2)).toEqual(['interval-cleared', 'worker-closed']);
  });

  it('keeps running when a periodic reconcile fails, logging only the error class', async () => {
    const { deps, logs, tick } = setup({ directoryFails: true });
    await expect(startTransmissionWorker(deps)).rejects.toThrow(); // the first one must succeed

    const ok = setup();
    const running = await startTransmissionWorker(ok.deps);
    ok.deps.directory.tenantIds = () => Promise.reject(new Error('db url postgres://u:pw@h'));
    ok.tick();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await running.stop();

    expect(ok.logs.join('\n')).toContain('reconcile failed');
    expect(ok.logs.join('\n')).not.toContain('postgres://');
    expect(logs.join('\n')).not.toContain('postgres://');
    expect(tick).toBeTypeOf('function');
  });

  /** Spec: HU-E11-01. The webhook delivery queue runs next to the transmission one. */
  it('also schedules the webhook delivery job per tenant, dropping the ones that are gone', async () => {
    const { deps, events } = setup();

    await startTransmissionWorker(withWebhooks(deps, events));

    expect(events).toEqual([
      'upsert:a:60000',
      'upsert:b:60000',
      'wh-upsert:a:30000',
      'wh-upsert:b:30000',
      'wh-remove:gone',
      'interval:300000',
    ]);
  });

  it('reconciles the webhook schedules on every periodic tick', async () => {
    const { deps, events, tick } = setup();
    await startTransmissionWorker(withWebhooks(deps, events));
    events.length = 0;

    tick();
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Webhook store already knows `a`: only the new tenant is added, the stale one removed.
    expect(events).toEqual([
      'upsert:a:60000',
      'upsert:b:60000',
      'wh-upsert:b:30000',
      'wh-remove:gone',
    ]);
  });

  it('closes the webhook worker together with the transmission one on stop', async () => {
    const { deps, events } = setup();
    const running = await startTransmissionWorker(withWebhooks(deps, events));

    await running.stop();

    expect(events.slice(-3)).toEqual([
      'interval-cleared',
      'worker-closed',
      'webhook-worker-closed',
    ]);
  });
});
