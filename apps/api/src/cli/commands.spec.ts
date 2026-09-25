import {
  apiKeys,
  createPgliteDatabase,
  tenantFiscalEconomicActivities,
  tenantFiscalProfiles,
  type Database,
  type DatabaseHandle,
} from '@sifen/db';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { createFiscalProfile } from '../modules/fiscal-config/domain/fiscal-profile.js';
import { parseRuc } from '../modules/fiscal-config/domain/ruc.js';
import {
  createPartner,
  createTenant,
  issueApiKey,
  revokeApiKey,
  setFiscalProfile,
} from './commands.js';

describe('operator CLI command handlers (HU-E1-05)', () => {
  let handle: DatabaseHandle | undefined;

  afterEach(async () => {
    await handle?.close();
    handle = undefined;
  });

  it('createPartner inserts a partner row', async () => {
    handle = createPgliteDatabase();
    await handle.migrate();

    const { id } = await createPartner(handle.db, 'Partner A');

    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('createTenant inserts a tenant without a partner by default', async () => {
    handle = createPgliteDatabase();
    await handle.migrate();

    const { id } = await createTenant(handle.db, 'Direct Tenant');

    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('createTenant links a tenant to a partner when given one', async () => {
    handle = createPgliteDatabase();
    await handle.migrate();
    const { id: partnerId } = await createPartner(handle.db, 'Partner B');

    const { id: tenantId } = await createTenant(handle.db, 'Partner Tenant', partnerId);

    expect(tenantId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('issueApiKey mints a key whose formatted token embeds the printed keyId', async () => {
    handle = createPgliteDatabase();
    await handle.migrate();
    const { id: tenantId } = await createTenant(handle.db, 'Key Tenant');

    const issued = await issueApiKey(handle.db, {
      tenantId,
      environment: 'test',
      scopes: ['documents:write'],
    });

    expect(issued.formattedKey).toContain(issued.keyId);
    expect(issued.apiKeyId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('revokeApiKey marks the key revoked by its public keyId', async () => {
    handle = createPgliteDatabase();
    await handle.migrate();
    const { id: tenantId } = await createTenant(handle.db, 'Revoke Tenant');
    const issued = await issueApiKey(handle.db, { tenantId, environment: 'test', scopes: [] });

    await revokeApiKey(handle.db, issued.keyId);

    const [row] = await handle.db.select().from(apiKeys).where(eq(apiKeys.keyId, issued.keyId));
    expect(row.revokedAt).toBeInstanceOf(Date);
  });

  it('revokeApiKey rejects an unknown keyId instead of reporting success', async () => {
    handle = createPgliteDatabase();
    await handle.migrate();

    await expect(revokeApiKey(handle.db, 'UnknownKeyId000000000000')).rejects.toThrow(
      'no active api key with keyId UnknownKeyId000000000000',
    );
  });

  it('revokeApiKey rejects an already revoked key and keeps the first revoked_at', async () => {
    handle = createPgliteDatabase();
    await handle.migrate();
    const { id: tenantId } = await createTenant(handle.db, 'Twice Tenant');
    const issued = await issueApiKey(handle.db, { tenantId, environment: 'test', scopes: [] });
    await revokeApiKey(handle.db, issued.keyId);
    const [first] = await handle.db.select().from(apiKeys).where(eq(apiKeys.keyId, issued.keyId));

    await expect(revokeApiKey(handle.db, issued.keyId)).rejects.toThrow('no active api key');

    const [after] = await handle.db.select().from(apiKeys).where(eq(apiKeys.keyId, issued.keyId));
    expect(after.revokedAt).toEqual(first.revokedAt);
  });
});

describe('setFiscalProfile (HU-E2-01)', () => {
  let handle: DatabaseHandle | undefined;

  afterEach(async () => {
    await handle?.close();
    handle = undefined;
  });

  const buildProfile = (activities: { code: string; description: string }[]) =>
    createFiscalProfile({
      ruc: parseRuc('4490207-7'),
      legalName: 'Acme SA',
      taxpayerType: 'persona_juridica',
      economicActivities: activities,
    });

  const profileRow = (db: Database, tenantId: string) =>
    db.select().from(tenantFiscalProfiles).where(eq(tenantFiscalProfiles.tenantId, tenantId));
  const activityRows = (db: Database, tenantId: string) =>
    db
      .select()
      .from(tenantFiscalEconomicActivities)
      .where(eq(tenantFiscalEconomicActivities.tenantId, tenantId));

  it('inserts a new fiscal profile with its economic activities', async () => {
    handle = createPgliteDatabase();
    await handle.migrate();
    const { id: tenantId } = await createTenant(handle.db, 'Fiscal Tenant');
    const profile = buildProfile([{ code: '62010', description: 'Programación informática' }]);

    const result = await setFiscalProfile(handle.db, { tenantId, profile });

    expect(result).toEqual({ tenantId, ruc: '4490207-7' });
    const [row] = await profileRow(handle.db, tenantId);
    expect(row).toMatchObject({ rucBase: '4490207', rucDv: 7, legalName: 'Acme SA' });
    const activities = await activityRows(handle.db, tenantId);
    expect(activities).toHaveLength(1);
    expect(activities[0]?.code).toBe('62010');
  });

  it('re-running replaces the profile and activities, bumping updated_at', async () => {
    handle = createPgliteDatabase();
    await handle.migrate();
    const { id: tenantId } = await createTenant(handle.db, 'Fiscal Tenant');
    await setFiscalProfile(handle.db, {
      tenantId,
      profile: buildProfile([{ code: '62010', description: 'Programación informática' }]),
    });
    const [before] = await profileRow(handle.db, tenantId);
    await new Promise((resolve) => setTimeout(resolve, 10));

    await setFiscalProfile(handle.db, {
      tenantId,
      profile: buildProfile([{ code: '62020', description: 'Consultoría informática' }]),
    });

    const rows = await profileRow(handle.db, tenantId);
    expect(rows).toHaveLength(1);
    expect(before?.updatedAt.getTime()).toBeLessThan(rows[0]?.updatedAt.getTime() ?? 0);
    const activities = await activityRows(handle.db, tenantId);
    expect(activities).toHaveLength(1);
    expect(activities[0]?.code).toBe('62020');
  });

  it('rejects an unknown tenant', async () => {
    handle = createPgliteDatabase();
    await handle.migrate();
    const profile = buildProfile([{ code: '62010', description: 'Programación informática' }]);

    await expect(
      setFiscalProfile(handle.db, { tenantId: '00000000-0000-0000-0000-000000000000', profile }),
    ).rejects.toThrow('tenant not found');
  });

  it('leaves no partial state when an activity fails to insert', async () => {
    handle = createPgliteDatabase();
    await handle.migrate();
    const { id: tenantId } = await createTenant(handle.db, 'Fiscal Tenant');
    // Built directly (not via createFiscalProfile) so the invalid code
    // reaches the handler and trips the DB check constraint inside the
    // transaction, instead of being rejected by domain validation first
    // (backlog HU-E2-01).
    const profile = {
      ruc: parseRuc('4490207-7'),
      legalName: 'Acme SA',
      tradeName: null,
      taxpayerType: 'persona_juridica' as const,
      regimeCode: null,
      economicActivities: [
        { code: '62010', description: 'Programación informática' },
        { code: 'inv@lid', description: 'Actividad inválida' },
      ],
    };

    await expect(setFiscalProfile(handle.db, { tenantId, profile })).rejects.toThrow();

    expect(await profileRow(handle.db, tenantId)).toHaveLength(0);
    expect(await activityRows(handle.db, tenantId)).toHaveLength(0);
  });
});
