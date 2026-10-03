import { describe, expect, it } from 'vitest';
import { reconcileTenantSchedules } from './reconcile-tenant-schedules.js';
import type { TenantDirectory } from './tenant-directory.js';
import type { TenantScheduleStore } from './queue.js';

function setup(tenants: string[], scheduled: string[]) {
  const calls: string[] = [];
  const directory: TenantDirectory = { tenantIds: () => Promise.resolve(tenants) };
  const schedules: TenantScheduleStore = {
    list: () => Promise.resolve(scheduled),
    upsert: (id, every) => {
      calls.push(`upsert:${id}:${String(every)}`);
      return Promise.resolve();
    },
    remove: (id) => {
      calls.push(`remove:${id}`);
      return Promise.resolve();
    },
  };
  return { directory, schedules, calls };
}

/** Spec: HU-E6-02 (S5e). One repeatable cycle job per tenant, kept in step with the tenants. */
describe('reconcileTenantSchedules', () => {
  it('schedules new tenants and unschedules the ones that are gone', async () => {
    const { directory, schedules, calls } = setup(['a', 'b'], ['b', 'c']);

    const result = await reconcileTenantSchedules({ directory, schedules, everyMs: 60_000 });

    expect(calls.sort()).toEqual(['remove:c', 'upsert:a:60000']);
    expect(result).toEqual({ added: ['a'], removed: ['c'] });
  });

  it('re-applies the cadence to every tenant when asked to refresh (startup)', async () => {
    const { directory, schedules, calls } = setup(['a', 'b'], ['a', 'b']);

    const result = await reconcileTenantSchedules({
      directory,
      schedules,
      everyMs: 30_000,
      refresh: true,
    });

    expect(calls).toEqual(['upsert:a:30000', 'upsert:b:30000']);
    expect(result).toEqual({ added: [], removed: [] });
  });

  it('does nothing when schedules already match', async () => {
    const { directory, schedules, calls } = setup(['a'], ['a']);
    await reconcileTenantSchedules({ directory, schedules, everyMs: 60_000 });
    expect(calls).toEqual([]);
  });
});
