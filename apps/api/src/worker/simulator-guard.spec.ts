import { afterEach, describe, expect, it } from 'vitest';
import { createPgliteDatabase, tenants, type DatabaseHandle } from '@sifen/db';
import { guardSimulatorTenants } from './simulator-guard.js';
import { createDrizzleTenantEnvironments } from './tenant-directory.js';

function setup(simulator: boolean, environment: 'test' | 'production') {
  const processed: string[] = [];
  const logs: string[] = [];
  const guarded = guardSimulatorTenants({
    simulator,
    environments: { environmentOf: () => Promise.resolve(environment) },
    logger: { warn: (message) => logs.push(message) },
    process: (data: { tenantId: string }) => {
      processed.push(data.tenantId);
      return Promise.resolve({ status: 'done' });
    },
  });
  return { guarded, processed, logs };
}

/** Spec: HU-E6-02 (S5e). A simulated SIFEN must never receive a production tenant's documents. */
describe('guardSimulatorTenants', () => {
  it('skips a production tenant while the gateway is the simulator, warning once per tenant', async () => {
    const { guarded, processed, logs } = setup(true, 'production');

    expect(await guarded({ tenantId: 't1' })).toEqual({ status: 'skipped' });
    expect(await guarded({ tenantId: 't1' })).toEqual({ status: 'skipped' });
    expect(await guarded({ tenantId: 't2' })).toEqual({ status: 'skipped' });

    expect(processed).toEqual([]);
    expect(logs).toHaveLength(2);
    expect(logs[0]).toContain('t1');
    expect(logs[0]).toContain('simulator');
  });

  it('processes test tenants with the simulator, and every tenant with a real gateway', async () => {
    const simulated = setup(true, 'test');
    expect(await simulated.guarded({ tenantId: 't1' })).toEqual({ status: 'done' });

    const real = setup(false, 'production');
    expect(await real.guarded({ tenantId: 't1' })).toEqual({ status: 'done' });
    expect(real.processed).toEqual(['t1']);
  });
});

describe('DrizzleTenantEnvironments', () => {
  let handle: DatabaseHandle | undefined;
  afterEach(async () => {
    await handle?.close();
    handle = undefined;
  });

  it('reads the current environment of a tenant as platform_admin and fails for an unknown one', async () => {
    handle = createPgliteDatabase();
    await handle.migrate();
    const [row] = await handle.db
      .insert(tenants)
      .values({ name: 'P', environment: 'production' })
      .returning({ id: tenants.id });
    const environments = createDrizzleTenantEnvironments(handle.db);

    expect(await environments.environmentOf(row.id)).toBe('production');
    await expect(
      environments.environmentOf('00000000-0000-4000-8000-000000000000'),
    ).rejects.toThrow('tenant not found');
  });
});
