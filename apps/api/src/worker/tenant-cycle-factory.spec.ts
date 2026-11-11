import { describe, expect, it } from 'vitest';
import { createTenantCycleFactory } from './tenant-cycle-factory.js';

const deps = {
  db: {} as never,
  gateway: {} as never,
  certificates: {} as never,
  cscs: {} as never,
};

describe('createTenantCycleFactory', () => {
  it.each([0, -3, Number.NaN, 2.5])(
    'rejects recoveryMaxQueries %s when the factory is built, not on the first tenant run',
    (value) => {
      expect(() => createTenantCycleFactory({ ...deps, recoveryMaxQueries: value })).toThrow(
        /maxQueries/,
      );
    },
  );

  it('accepts a missing or positive recoveryMaxQueries', () => {
    expect(() => createTenantCycleFactory(deps)).not.toThrow();
    expect(() => createTenantCycleFactory({ ...deps, recoveryMaxQueries: 5 })).not.toThrow();
  });

  it("asks a gateway function for each tenant's own gateway", () => {
    const asked: string[] = [];
    const create = createTenantCycleFactory({
      ...deps,
      gateway: (tenantId: string) => {
        asked.push(tenantId);
        return {} as never;
      },
    });
    create('tenant-a');
    create('tenant-b');
    expect(asked).toEqual(['tenant-a', 'tenant-b']);
  });
});
