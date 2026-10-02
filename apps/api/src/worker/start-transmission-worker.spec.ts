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
});
