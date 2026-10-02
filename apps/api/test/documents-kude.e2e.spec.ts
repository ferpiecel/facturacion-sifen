import { type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import {
  createPgliteDatabase,
  tenants,
  tenantEstablishments,
  tenantExpeditionPoints,
  tenantFiscalProfiles,
  tenantTimbrados,
  documents,
  type DatabaseHandle,
} from '@sifen/db';
import { eq } from 'drizzle-orm';
import { signedInvoiceWithQr } from './support/signed-invoice.js';
import { pdfText } from '../src/modules/emission/infrastructure/kude/pdf-inspect.test-helper.js';
import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTenant, issueApiKey } from '../src/cli/commands.js';
import { createHttpAdapter } from '../src/bootstrap/http.js';
import { AppModule } from '../src/app.module.js';
import { DATABASE, DATABASE_HANDLE } from '../src/modules/database/database.module.js';

const BODY = {
  establishment: '001',
  expeditionPoint: '002',
  operationType: 'B2B',
  receiver: {
    kind: 'named',
    ruc: '80069563-1',
    isPublicEntity: false,
    name: 'Cliente SA',
    address: 'Av. Mariscal Lopez',
    houseNumber: '123',
    districtCode: 1,
    districtDescription: 'ASUNCION (DISTRITO)',
    cityCode: 1,
    cityDescription: 'ASUNCION (DISTRITO)',
  },
  items: [
    {
      code: 'A-001',
      description: 'Servicio de consultoria',
      unitCode: 77,
      quantity: 1,
      unitPrice: 110_000,
      vatRate: 10,
    },
  ],
  roundingPyg: 0,
  location: { departmentCode: 11 },
};

/** Spec: HU-E10-01. `GET /v1/documents/{id}/kude` through the real pipeline. */
describe('GET /v1/documents/{id}/kude (e2e)', () => {
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

  const sign = async (id: string) => {
    await handle.db
      .update(documents)
      .set({ status: 'signed', signedXml: await signedInvoiceWithQr(), signedAt: new Date() })
      .where(eq(documents.id, id));
  };

  it('returns the KuDE PDF inline once the document is signed', async () => {
    const { document_id: id } = await create(writer);
    await sign(id);

    const response = await get(`/v1/documents/${id}/kude`, reader);

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('application/pdf');
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.headers['content-disposition']).toBe(
      'inline; filename="kude-001-002-0000001.pdf"',
    );
    expect(response.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
    expect(await pdfText(new Uint8Array(response.rawPayload))).toContain(
      'KuDE de Factura Electrónica',
    );
  });

  it('answers 409 while the document has no signed XML', async () => {
    const { document_id: id } = await create(writer);

    expect((await get(`/v1/documents/${id}/kude`, reader)).statusCode).toBe(409);
  });

  it("answers an identical 404 for another tenant's, an unknown and another environment's document", async () => {
    const { document_id: id } = await create(writer);
    await sign(id);

    const foreign = await get(`/v1/documents/${id}/kude`, other);
    const unknown = await get(`/v1/documents/${crypto.randomUUID()}/kude`, other);
    expect([foreign.statusCode, unknown.statusCode]).toEqual([404, 404]);
    expect(foreign.json()).toEqual(unknown.json());

    await handle.db
      .update(tenants)
      .set({ environment: 'production' })
      .where(eq(tenants.id, tenantId));
    expect((await get(`/v1/documents/${id}/kude`, reader)).statusCode).toBe(404);
  });

  it('answers 400 for a malformed id, 401 without a key and 403 without documents:read', async () => {
    const { document_id: id } = await create(writer);
    const writeOnly = await seedTenant('Write SA', ['documents:write']);

    expect((await get('/v1/documents/nope/kude', reader)).statusCode).toBe(400);
    expect((await get(`/v1/documents/${id}/kude`, null)).statusCode).toBe(401);
    expect((await get(`/v1/documents/${id}/kude`, writeOnly)).statusCode).toBe(403);
  });

  it('answers a sanitized 500 and logs no XML when the stored XML cannot be printed', async () => {
    const logged = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { document_id: id } = await create(writer);
    await handle.db
      .update(documents)
      .set({
        status: 'signed',
        signedXml: '<rDE><secret>TOKEN-123</secret></rDE>',
        signedAt: new Date(),
      })
      .where(eq(documents.id, id));

    const response = await get(`/v1/documents/${id}/kude`, reader);

    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain('TOKEN-123');
    const lines = logged.mock.calls.map((call) => String(call[0]));
    expect(lines.some((line) => line.includes(id))).toBe(true);
    expect(lines.join('\n')).not.toMatch(/TOKEN-123|<rDE>/);
    logged.mockRestore();
  });

  it('answers 500 when the QR environment is not the document environment', async () => {
    const logged = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { document_id: id } = await create(writer);
    const xml = (await signedInvoiceWithQr()).replace('/consultas-test/qr?', '/consultas/qr?');
    await handle.db
      .update(documents)
      .set({ status: 'signed', signedXml: xml, signedAt: new Date() })
      .where(eq(documents.id, id));

    expect((await get(`/v1/documents/${id}/kude`, reader)).statusCode).toBe(500);
    logged.mockRestore();
  });
});
