import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import {
  createPgliteDatabase,
  documents,
  tenantEstablishments,
  tenantExpeditionPoints,
  tenantDocumentSequences,
  tenantFiscalProfiles,
  tenantTimbrados,
  type DatabaseHandle,
} from '@sifen/db';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTenant, issueApiKey } from '../src/cli/commands.js';
import { AppModule } from '../src/app.module.js';
import { DATABASE, DATABASE_HANDLE } from '../src/modules/database/database.module.js';
import { parseCdc } from '../src/modules/emission/domain/cdc.js';

const BODY = {
  establishment: '001',
  expeditionPoint: '002',
  operationType: 'B2B',
  receiver: { kind: 'named', ruc: '80069563-1', isPublicEntity: false },
  items: [{ quantity: 1, unitPrice: 110_000, vatRate: 10 }],
  roundingPyg: 0,
  location: { departmentCode: 11 },
};

/** Spec: HU-E5-01 (S3). `POST /v1/documents` through the real pipeline (guard, tenancy, pglite). */
describe('POST /v1/documents (e2e)', () => {
  let handle: DatabaseHandle;
  let app: NestFastifyApplication;
  let tenantId: string;
  let bearer: string;
  const originalEnvironment = process.env.SIFEN_ENVIRONMENT;

  async function seedTenant(name: string, withIssuer: boolean) {
    const { id } = await createTenant(handle.db, name);
    const { formattedKey } = await issueApiKey(handle.db, {
      tenantId: id,
      environment: 'live',
      scopes: ['documents:write'],
    });
    if (withIssuer) {
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
    }
    return { id, formattedKey };
  }

  beforeEach(async () => {
    process.env.SIFEN_ENVIRONMENT = 'production';
    handle = createPgliteDatabase();
    await handle.migrate();
    const seeded = await seedTenant('Acme SA', true);
    tenantId = seeded.id;
    bearer = seeded.formattedKey;
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(DATABASE_HANDLE)
      .useValue(handle)
      .overrideProvider(DATABASE)
      .useValue(handle.db)
      .compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterEach(async () => {
    await app.close();
    if (originalEnvironment === undefined) delete process.env.SIFEN_ENVIRONMENT;
    else process.env.SIFEN_ENVIRONMENT = originalEnvironment;
  });

  const post = (body: unknown, key: string | null = bearer) =>
    app.inject({
      method: 'POST',
      url: '/v1/documents',
      payload: body as object,
      headers: key ? { authorization: `Bearer ${key}` } : {},
    });

  it('accepts a valid invoice with 202, a document id and a 44-digit CDC', async () => {
    const response = await post(BODY);

    expect(response.statusCode).toBe(202);
    const { document_id: documentId, cdc } = response.json<{ document_id: string; cdc: string }>();
    expect(cdc).toMatch(/^\d{44}$/);
    expect(parseCdc(cdc)).toMatchObject({ establishment: '001', point: '002' });
    const rows = await handle.db.select().from(documents).where(eq(documents.id, documentId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tenantId, cdc, receiverRuc: '80069563-1' });
  });

  it('rejects a request without a valid API key with 401', async () => {
    expect((await post(BODY, null)).statusCode).toBe(401);
    expect((await post(BODY, 'sk_live_nope')).statusCode).toBe(401);
  });

  it('answers 422 with field details when the body shape is wrong', async () => {
    const response = await post({ ...BODY, items: 'none', establishment: 1 });

    expect(response.statusCode).toBe(422);
    const { errors } = response.json<{ errors: Array<{ field: string }> }>();
    expect(errors.map((e) => e.field)).toEqual(expect.arrayContaining(['items', 'establishment']));
  });

  it('answers 422 with every domain rule violated and persists nothing', async () => {
    const response = await post({
      ...BODY,
      receiver: { kind: 'unnamed' },
      items: [{ quantity: 1, unitPrice: 8_000_000, vatRate: 10 }],
      roundingPyg: 20,
    });

    expect(response.statusCode).toBe(422);
    const { errors } = response.json<{
      errors: Array<{ field: string; rule: string; sifenCode?: string }>;
    }>();
    expect(errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ rule: 'unnamed-receiver-over-threshold', sifenCode: '1321' }),
        expect.objectContaining({ rule: 'rounding-multiple-of-50', field: 'roundingPyg' }),
      ]),
    );
    expect(await handle.db.select().from(documents)).toHaveLength(0);
  });

  it('answers 422 when the establishment or point is not configured for the tenant', async () => {
    const response = await post({ ...BODY, establishment: '009' });

    expect(response.statusCode).toBe(422);
    expect(response.json<{ message: string }>().message).toMatch(/not configured/i);
  });

  it("never resolves another tenant's issuer setup (tenant isolation)", async () => {
    const other = await seedTenant('Other SA', false);

    const response = await post(BODY, other.formattedKey);

    expect(response.statusCode).toBe(422);
    expect(await handle.db.select().from(documents)).toHaveLength(0);
  });

  it('answers 422 when an unnamed receiver carries a RUC or a named one has an invalid RUC', async () => {
    const unnamed = await post({ ...BODY, receiver: { kind: 'unnamed', ruc: '80069563-1' } });
    const badRuc = await post({ ...BODY, receiver: { kind: 'named', ruc: '80069563-9' } });

    for (const response of [unnamed, badRuc]) {
      expect(response.statusCode).toBe(422);
      expect(response.json<{ errors: Array<{ field: string }> }>().errors[0]?.field).toBe(
        'receiver.ruc',
      );
    }
    expect(await handle.db.select().from(documents)).toHaveLength(0);
  });

  it('answers 409 when the sequence of the point is exhausted, never a raw 500', async () => {
    const [est] = await handle.db.select().from(tenantEstablishments);
    const [point] = await handle.db.select().from(tenantExpeditionPoints);
    const [timbrado] = await handle.db.select().from(tenantTimbrados);
    await handle.db.insert(tenantDocumentSequences).values({
      tenantId,
      environment: 'test',
      timbradoId: timbrado.id,
      establishmentId: est.id,
      expeditionPointId: point.id,
      documentType: 1,
      series: 'ZZ',
      lastNumber: 9_999_998,
    });

    expect((await post(BODY)).statusCode).toBe(202);
    const response = await post(BODY);

    expect(response.statusCode).toBe(409);
    expect(response.json<{ message: string }>().message).toMatch(/exhausted/i);
  });
});
