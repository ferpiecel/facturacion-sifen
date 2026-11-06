import {
  createPgliteDatabase,
  tenantFiscalProfiles,
  tenants,
  type DatabaseHandle,
} from '@sifen/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDrizzleTenantFiscalIdentity } from './drizzle-tenant-fiscal-identity.js';

/** Spec: reception R3.3. Reads only the RUC pair, under forced RLS as app_user. */
describe('DrizzleTenantFiscalIdentity', () => {
  let handle: DatabaseHandle;
  let tenantA: string;
  let tenantB: string;
  let tenantWithoutProfile: string;

  beforeEach(async () => {
    handle = createPgliteDatabase();
    await handle.migrate();
    const rows = await handle.db
      .insert(tenants)
      .values([{ name: 'A' }, { name: 'B' }, { name: 'C' }])
      .returning();
    [tenantA, tenantB, tenantWithoutProfile] = rows.map((row) => row.id);
    await handle.db
      .insert(tenantFiscalProfiles)
      .values([profile(tenantA, '80000001', 8), profile(tenantB, '80000002', 5)]);
  });
  afterEach(async () => {
    await handle.close();
  });

  const profile = (tenantId: string, rucBase: string, rucDv: number) => ({
    tenantId,
    rucBase,
    rucDv,
    legalName: 'Empresa SA',
    taxpayerType: 'persona_juridica' as const,
  });

  it('returns the RUC base and check digit of the tenant', async () => {
    const identity = createDrizzleTenantFiscalIdentity(handle.db);
    expect(await identity.getRucIdentity(tenantA)).toEqual({ rucBase: '80000001', dv: 8 });
  });

  it('never reads another tenant identity', async () => {
    const identity = createDrizzleTenantFiscalIdentity(handle.db);
    expect(await identity.getRucIdentity(tenantB)).toEqual({ rucBase: '80000002', dv: 5 });
    expect(await identity.getRucIdentity(tenantA)).not.toEqual({ rucBase: '80000002', dv: 5 });
  });

  it('returns null when the tenant has no fiscal profile', async () => {
    const identity = createDrizzleTenantFiscalIdentity(handle.db);
    expect(await identity.getRucIdentity(tenantWithoutProfile)).toBeNull();
  });
});
