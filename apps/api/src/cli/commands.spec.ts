import {
  apiKeys,
  createPgliteDatabase,
  tenantEstablishments,
  tenantExpeditionPoints,
  tenantFiscalEconomicActivities,
  tenantFiscalProfiles,
  tenants,
  tenantTimbrados,
  type Database,
  type DatabaseHandle,
} from '@sifen/db';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createEstablishment,
  createEstablishmentContact,
} from '../modules/fiscal-config/domain/establishment.js';
import { createExpeditionPoint } from '../modules/fiscal-config/domain/expedition-point.js';
import { createFiscalProfile } from '../modules/fiscal-config/domain/fiscal-profile.js';
import { parseRuc } from '../modules/fiscal-config/domain/ruc.js';
import { createTimbrado } from '../modules/fiscal-config/domain/timbrado.js';
import {
  addEstablishment,
  setEstablishmentContact,
  addExpeditionPoint,
  addTimbrado,
  createPartner,
  createTenant,
  issueApiKey,
  revokeApiKey,
  setFiscalProfile,
  setTenantEnvironment,
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
    expect(activities[0].code).toBe('62010');
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
    const [after] = rows;
    expect(before.updatedAt.getTime()).toBeLessThan(after.updatedAt.getTime());
    const activities = await activityRows(handle.db, tenantId);
    expect(activities).toHaveLength(1);
    expect(activities[0].code).toBe('62020');
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

describe('addEstablishment (HU-E2-02)', () => {
  let handle: DatabaseHandle | undefined;

  afterEach(async () => {
    await handle?.close();
    handle = undefined;
  });

  const buildEstablishment = (code = '001') =>
    createEstablishment({
      code,
      address: 'Avda. Siempre Viva 123',
      houseNumber: '123',
      addressComplement1: 'Casi Av. Mcal. Lopez',
      addressComplement2: 'Piso 2',
      departmentCode: 11,
      districtCode: '145',
      districtDescription: 'Ciudad del Este',
      cityCode: '3316',
      cityDescription: 'Ciudad del Este',
    });

  it('inserts an establishment for an existing tenant, persisting every field', async () => {
    handle = createPgliteDatabase();
    await handle.migrate();
    const { id: tenantId } = await createTenant(handle.db, 'Establishment Tenant');

    const result = await addEstablishment(handle.db, {
      tenantId,
      establishment: buildEstablishment(),
    });

    expect(result.code).toBe('001');
    const [row] = await handle.db
      .select()
      .from(tenantEstablishments)
      .where(eq(tenantEstablishments.id, result.id));
    expect(row).toMatchObject({
      tenantId,
      code: '001',
      address: 'Avda. Siempre Viva 123',
      houseNumber: '123',
      addressComplement1: 'Casi Av. Mcal. Lopez',
      addressComplement2: 'Piso 2',
      departmentCode: '11',
      districtCode: '145',
      districtDescription: 'Ciudad del Este',
      cityCode: '3316',
      cityDescription: 'Ciudad del Este',
    });
  });

  it('inserts an establishment without district/district-description (both optional)', async () => {
    handle = createPgliteDatabase();
    await handle.migrate();
    const { id: tenantId } = await createTenant(handle.db, 'Establishment Tenant');

    const establishment = createEstablishment({
      code: '002',
      address: 'Avda. Siempre Viva 123',
      houseNumber: '123',
      departmentCode: 11,
      cityCode: '3316',
      cityDescription: 'Ciudad del Este',
    });

    const result = await addEstablishment(handle.db, { tenantId, establishment });

    const [row] = await handle.db
      .select()
      .from(tenantEstablishments)
      .where(eq(tenantEstablishments.id, result.id));
    expect(row).toMatchObject({
      districtCode: null,
      districtDescription: null,
      addressComplement1: null,
      addressComplement2: null,
    });
  });

  it('rejects an unknown tenant', async () => {
    handle = createPgliteDatabase();
    await handle.migrate();

    await expect(
      addEstablishment(handle.db, {
        tenantId: '00000000-0000-0000-0000-000000000000',
        establishment: buildEstablishment(),
      }),
    ).rejects.toThrow('tenant not found');
  });

  it('rejects a duplicate code for the same tenant', async () => {
    handle = createPgliteDatabase();
    await handle.migrate();
    const { id: tenantId } = await createTenant(handle.db, 'Establishment Tenant');
    await addEstablishment(handle.db, { tenantId, establishment: buildEstablishment() });

    const rejection = addEstablishment(handle.db, {
      tenantId,
      establishment: buildEstablishment(),
    });
    await expect(rejection).rejects.toThrow();
    const cause = await rejection.catch((error: unknown) => (error as { cause?: unknown }).cause);
    expect(cause).toBeInstanceOf(Error);
    expect((cause as Error).message).toContain('tenant_establishments_tenant_code_idx');
  });
});

describe('addExpeditionPoint (HU-E2-02)', () => {
  let handle: DatabaseHandle | undefined;

  afterEach(async () => {
    await handle?.close();
    handle = undefined;
  });

  const buildEstablishment = () =>
    createEstablishment({
      code: '001',
      address: 'Avda. Siempre Viva 123',
      houseNumber: '123',
      departmentCode: 11,
      districtCode: '145',
      districtDescription: 'Ciudad del Este',
      cityCode: '3316',
      cityDescription: 'Ciudad del Este',
    });

  it('inserts an expedition point resolved by tenant and establishment code', async () => {
    handle = createPgliteDatabase();
    await handle.migrate();
    const { id: tenantId } = await createTenant(handle.db, 'Point Tenant');
    await addEstablishment(handle.db, { tenantId, establishment: buildEstablishment() });

    const result = await addExpeditionPoint(handle.db, {
      tenantId,
      establishmentCode: '001',
      point: createExpeditionPoint({ code: '002' }),
    });

    expect(result.code).toBe('002');
    const [row] = await handle.db
      .select()
      .from(tenantExpeditionPoints)
      .where(eq(tenantExpeditionPoints.id, result.id));
    expect(row).toMatchObject({ tenantId, code: '002' });
  });

  it('rejects an unknown tenant', async () => {
    handle = createPgliteDatabase();
    await handle.migrate();

    await expect(
      addExpeditionPoint(handle.db, {
        tenantId: '00000000-0000-0000-0000-000000000000',
        establishmentCode: '001',
        point: createExpeditionPoint({ code: '002' }),
      }),
    ).rejects.toThrow('tenant not found');
  });

  it('rejects an unknown establishment code for the tenant', async () => {
    handle = createPgliteDatabase();
    await handle.migrate();
    const { id: tenantId } = await createTenant(handle.db, 'Point Tenant');

    await expect(
      addExpeditionPoint(handle.db, {
        tenantId,
        establishmentCode: '999',
        point: createExpeditionPoint({ code: '002' }),
      }),
    ).rejects.toThrow('establishment not found');
  });

  it('rejects a duplicate code for the same establishment', async () => {
    handle = createPgliteDatabase();
    await handle.migrate();
    const { id: tenantId } = await createTenant(handle.db, 'Point Tenant');
    await addEstablishment(handle.db, { tenantId, establishment: buildEstablishment() });
    await addExpeditionPoint(handle.db, {
      tenantId,
      establishmentCode: '001',
      point: createExpeditionPoint({ code: '002' }),
    });

    const rejection = addExpeditionPoint(handle.db, {
      tenantId,
      establishmentCode: '001',
      point: createExpeditionPoint({ code: '002' }),
    });
    await expect(rejection).rejects.toThrow();
    const cause = await rejection.catch((error: unknown) => (error as { cause?: unknown }).cause);
    expect(cause).toBeInstanceOf(Error);
    expect((cause as Error).message).toContain(
      'tenant_expedition_points_tenant_establishment_code_idx',
    );
  });
});

describe('addTimbrado (HU-E2-02)', () => {
  let handle: DatabaseHandle | undefined;

  afterEach(async () => {
    await handle?.close();
    handle = undefined;
  });

  const buildTimbrado = (number = '12345678') =>
    createTimbrado({ number, validityStart: '2024-01-01', validityEnd: '2025-01-01' });

  it('inserts a timbrado for an existing tenant', async () => {
    handle = createPgliteDatabase();
    await handle.migrate();
    const { id: tenantId } = await createTenant(handle.db, 'Timbrado Tenant');

    const result = await addTimbrado(handle.db, { tenantId, timbrado: buildTimbrado() });

    expect(result.number).toBe('12345678');
    const [row] = await handle.db
      .select()
      .from(tenantTimbrados)
      .where(eq(tenantTimbrados.id, result.id));
    expect(row).toMatchObject({
      tenantId,
      number: '12345678',
      validFrom: '2024-01-01',
      validTo: '2025-01-01',
    });
  });

  it('rejects an unknown tenant', async () => {
    handle = createPgliteDatabase();
    await handle.migrate();

    await expect(
      addTimbrado(handle.db, {
        tenantId: '00000000-0000-0000-0000-000000000000',
        timbrado: buildTimbrado(),
      }),
    ).rejects.toThrow('tenant not found');
  });

  it('rejects a duplicate number for the same tenant', async () => {
    handle = createPgliteDatabase();
    await handle.migrate();
    const { id: tenantId } = await createTenant(handle.db, 'Timbrado Tenant');
    await addTimbrado(handle.db, { tenantId, timbrado: buildTimbrado() });

    const rejection = addTimbrado(handle.db, { tenantId, timbrado: buildTimbrado() });
    await expect(rejection).rejects.toThrow();
    const cause = await rejection.catch((error: unknown) => (error as { cause?: unknown }).cause);
    expect(cause).toBeInstanceOf(Error);
    expect((cause as Error).message).toContain('tenant_timbrados_tenant_number_idx');
  });
});

describe('setTenantEnvironment (HU-E2-04)', () => {
  let handle: DatabaseHandle | undefined;

  afterEach(async () => {
    await handle?.close();
    handle = undefined;
  });

  it('a new tenant defaults to "test"', async () => {
    handle = createPgliteDatabase();
    await handle.migrate();
    const { id: tenantId } = await createTenant(handle.db, 'Env Tenant');

    const rows = await handle.db.select().from(tenants).where(eq(tenants.id, tenantId));
    expect(rows).toMatchObject([{ environment: 'test' }]);
  });

  it('switches a tenant to "production"', async () => {
    handle = createPgliteDatabase();
    await handle.migrate();
    const { id: tenantId } = await createTenant(handle.db, 'Env Tenant');

    const result = await setTenantEnvironment(handle.db, { tenantId, environment: 'production' });

    expect(result).toEqual({ id: tenantId, environment: 'production' });
    const rows = await handle.db.select().from(tenants).where(eq(tenants.id, tenantId));
    expect(rows).toMatchObject([{ environment: 'production' }]);
  });

  it('rejects an unknown tenant', async () => {
    handle = createPgliteDatabase();
    await handle.migrate();

    await expect(
      setTenantEnvironment(handle.db, {
        tenantId: '00000000-0000-0000-0000-000000000000',
        environment: 'production',
      }),
    ).rejects.toThrow('tenant not found');
  });
});

describe('establishment contact (HU-E6-02)', () => {
  let handle: DatabaseHandle | undefined;

  afterEach(async () => {
    await handle?.close();
    handle = undefined;
  });

  const base = {
    code: '001',
    address: 'Avda. Siempre Viva 123',
    houseNumber: '123',
    departmentCode: 11,
    cityCode: '3316',
    cityDescription: 'Ciudad del Este',
  };
  const contact = { phone: '0973-000000', email: 'emisor@test.com', commercialName: 'Casa Matriz' };

  async function setup() {
    handle = createPgliteDatabase();
    await handle.migrate();
    const { id: tenantId } = await createTenant(handle.db, 'Contact Tenant');
    return { db: handle.db, tenantId };
  }

  const rowOf = (db: DatabaseHandle['db'], id: string) =>
    db
      .select()
      .from(tenantEstablishments)
      .where(eq(tenantEstablishments.id, id))
      .then((rows) => rows[0]);

  it('addEstablishment persists the contact', async () => {
    const { db, tenantId } = await setup();
    const result = await addEstablishment(db, {
      tenantId,
      establishment: createEstablishment({ ...base, ...contact }),
    });
    expect(await rowOf(db, result.id)).toMatchObject(contact);
  });

  it('setEstablishmentContact updates only the contact of the named establishment', async () => {
    const { db, tenantId } = await setup();
    const first = await addEstablishment(db, {
      tenantId,
      establishment: createEstablishment(base),
    });
    const second = await addEstablishment(db, {
      tenantId,
      establishment: createEstablishment({ ...base, code: '002' }),
    });

    const result = await setEstablishmentContact(db, {
      tenantId,
      establishmentCode: '001',
      contact: createEstablishmentContact(contact),
    });

    expect(result).toEqual({ id: first.id, code: '001' });
    expect(await rowOf(db, first.id)).toMatchObject({ ...contact, address: base.address });
    expect(await rowOf(db, second.id)).toMatchObject({ phone: null, email: null });
  });

  it('fails clearly for an unknown establishment or tenant', async () => {
    const { db, tenantId } = await setup();
    await expect(
      setEstablishmentContact(db, {
        tenantId,
        establishmentCode: '009',
        contact: createEstablishmentContact(contact),
      }),
    ).rejects.toThrow('establishment not found');
  });
});
