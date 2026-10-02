import { type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import {
  createPgliteDatabase,
  tenants,
  tenantEstablishments,
  tenantExpeditionPoints,
  tenantFiscalProfiles,
  tenantTimbrados,
  type DatabaseHandle,
} from '@sifen/db';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTenant, issueApiKey } from '../src/cli/commands.js';
import { createHttpAdapter } from '../src/bootstrap/http.js';
import { AppModule } from '../src/app.module.js';
import { DATABASE, DATABASE_HANDLE } from '../src/modules/database/database.module.js';

const BODY = {
  establishment: '001',
  expeditionPoint: '002',
  operationType: 'B2B',
  receiver: { kind: 'named', ruc: '80069563-1', isPublicEntity: false },
  items: [{ quantity: 1, unitPrice: 110_000, vatRate: 10 }],
  roundingPyg: 0,
  location: { departmentCode: 11 },
};

/** Spec: HU-E5-07. `GET /v1/documents/{id}` and `?cdc=` through the real pipeline. */
describe('GET /v1/documents (e2e)', () => {
  let handle: DatabaseHandle;
  let app: NestFastifyApplication;
  const originalEnvironment = process.env.SIFEN_ENVIRONMENT;

  async function seedTenant(name: string, scopes: string[]) {
    const { id } = await createTenant(handle.db, name);
    const { formattedKey } = await issueApiKey(handle.db, {
      tenantId: id,
      environment: 'live',
      scopes,
    });
    await handle.db.insert(tenantFiscalProfiles).values({
      tenantId: id,
      rucBase: '80069563',
      rucDv: 1,
      legalName: 'Empresa SA',
      taxpayerType: 'persona_juridica',
    });
    const [est] = await handle.db
      .insert(tenantEstablishments)
      .values({
        tenantId: id,
        code: '001',
        address: 'Av. Mariscal Lopez 123',
        houseNumber: '123',
        departmentCode: '11',
        cityCode: '3432',
        cityDescription: 'Asuncion',
      })
      .returning();
    await handle.db
      .insert(tenantExpeditionPoints)
      .values({ tenantId: id, establishmentId: est.id, code: '002' });
    await handle.db
      .insert(tenantTimbrados)
      .values({ tenantId: id, number: '22222222', validFrom: '2020-01-01' });
    return formattedKey;
  }

  let sequence = 0;
  const auth = (key: string) => ({ authorization: `Bearer ${key}` });
  const create = async (key: string) => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/documents',
      payload: BODY,
      headers: { ...auth(key), 'idempotency-key': `q-${String(++sequence)}` },
    });
    return response.json<{ document_id: string; cdc: string }>();
  };
  const get = (url: string, key: string | null) =>
    app.inject({ method: 'GET', url, headers: key ? auth(key) : {} });

  let writer: string;
  let reader: string;
  let tenantId: string;
  let other: string;

  beforeEach(async () => {
    process.env.SIFEN_ENVIRONMENT = 'production';
    handle = createPgliteDatabase();
    await handle.migrate();
    writer = await seedTenant('Acme SA', ['documents:write', 'documents:read']);
    reader = writer;
    tenantId = (await handle.db.select().from(tenants).where(eq(tenants.name, 'Acme SA')))[0].id;
    other = await seedTenant('Other SA', ['documents:read']);
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(DATABASE_HANDLE)
      .useValue(handle)
      .overrideProvider(DATABASE)
      .useValue(handle.db)
      .compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(createHttpAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterEach(async () => {
    await app.close();
    if (originalEnvironment === undefined) delete process.env.SIFEN_ENVIRONMENT;
    else process.env.SIFEN_ENVIRONMENT = originalEnvironment;
  });

  it('returns the document by id, without the payload', async () => {
    const { document_id: id, cdc } = await create(writer);

    const response = await get(`/v1/documents/${id}`, reader);

    expect(response.statusCode).toBe(200);
    const { issued_at: issuedAt, ...body } = response.json<{ issued_at: string }>();
    expect(issuedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(body).toEqual({
      document_id: id,
      cdc,
      number: '001-002-0000001',
      status: 'accepted',
      environment: 'test',
      totals: { amount: '110000', currency: 'PYG' },
      receiver: { ruc: '80069563-1' },
      sifen: null,
      urls: { xml: null, kude: null },
    });
  });

  it('returns the same document by cdc', async () => {
    const { document_id: id, cdc } = await create(writer);

    const response = await get(`/v1/documents?cdc=${cdc}`, reader);

    expect(response.statusCode).toBe(200);
    expect(response.json<{ document_id: string }>().document_id).toBe(id);
  });

  it("answers 404 for another tenant's id and cdc, and for unknown ones", async () => {
    const { document_id: id, cdc } = await create(writer);

    expect((await get(`/v1/documents/${id}`, other)).statusCode).toBe(404);
    expect((await get(`/v1/documents?cdc=${cdc}`, other)).statusCode).toBe(404);
    expect((await get(`/v1/documents/${crypto.randomUUID()}`, reader)).statusCode).toBe(404);
    expect((await get(`/v1/documents?cdc=${'9'.repeat(44)}`, reader)).statusCode).toBe(404);
  });

  it('answers 400 for malformed identifiers', async () => {
    expect((await get('/v1/documents/not-a-uuid', reader)).statusCode).toBe(400);
    expect((await get('/v1/documents?cdc=123', reader)).statusCode).toBe(400);
    expect((await get('/v1/documents', reader)).statusCode).toBe(400);
    const cdc = '1'.repeat(44);
    expect((await get(`/v1/documents?cdc=${cdc}&cdc=${cdc}`, reader)).statusCode).toBe(400);
  });

  it("answers 404 with the same body for an unknown id and another tenant's id", async () => {
    const { document_id: id } = await create(writer);

    const foreign = await get(`/v1/documents/${id}`, other);
    const unknown = await get(`/v1/documents/${crypto.randomUUID()}`, other);

    expect([foreign.statusCode, unknown.statusCode]).toEqual([404, 404]);
    expect(foreign.json()).toEqual(unknown.json());
  });

  it('answers 403 on POST /v1/documents for a read-only key', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/documents',
      payload: BODY,
      headers: { ...auth(other), 'idempotency-key': 'read-only' },
    });

    expect(response.statusCode).toBe(403);
  });

  it("answers 404 for a document of the tenant's other environment, by id and by cdc", async () => {
    const { document_id: id, cdc } = await create(writer);
    // The tenant later moves to production: its test-environment documents are no longer current.
    await handle.db
      .update(tenants)
      .set({ environment: 'production' })
      .where(eq(tenants.id, tenantId));

    expect((await get(`/v1/documents/${id}`, reader)).statusCode).toBe(404);
    expect((await get(`/v1/documents?cdc=${cdc}`, reader)).statusCode).toBe(404);
  });

  it('answers 401 without a key and 403 without the documents:read scope', async () => {
    const { document_id: id } = await create(writer);
    const writeOnly = await seedTenant('Write SA', ['documents:write']);

    expect((await get(`/v1/documents/${id}`, null)).statusCode).toBe(401);
    expect((await get(`/v1/documents/${id}`, writeOnly)).statusCode).toBe(403);
  });
});
