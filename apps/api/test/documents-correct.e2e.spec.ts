import { type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { createPgliteDatabase, documents, type DatabaseHandle } from '@sifen/db';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTenant, issueApiKey } from '../src/cli/commands.js';
import { createHttpAdapter } from '../src/bootstrap/http.js';
import { AppModule } from '../src/app.module.js';
import { DATABASE, DATABASE_HANDLE } from '../src/modules/database/database.module.js';
import { acceptInvoiceWithStatus, FE_BODY, seedIssuer } from './support/credit-note-fixture.js';

/** Spec: HU-E8-01 (ADR-0021). `POST /v1/documents/{id}/correct` through the real pipeline. */
describe('POST /v1/documents/{id}/correct (e2e)', () => {
  let handle: DatabaseHandle;
  let app: NestFastifyApplication;
  const originalEnvironment = process.env.SIFEN_ENVIRONMENT;

  const tenantIds = new Map<string, string>();
  async function seedTenant(name: string, scopes: string[]) {
    const { id } = await createTenant(handle.db, name);
    const { formattedKey } = await issueApiKey(handle.db, {
      tenantId: id,
      environment: 'live',
      scopes,
    });
    await seedIssuer(handle.db, id);
    tenantIds.set(formattedKey, id);
    return formattedKey;
  }

  let sequence = 0;
  const auth = (key: string) => ({ authorization: `Bearer ${key}` });
  /** Issued now: the fixture's default issue date is long past the 72 h window. */
  const create = (key: string, status = 'rejected') =>
    acceptInvoiceWithStatus(
      handle.db,
      tenantIds.get(key) ?? '',
      `c-${String(++sequence)}`,
      status,
      FE_BODY,
      new Date(),
    );
  const correct = (id: string, key: string, body: unknown, idempotencyKey?: string) =>
    app.inject({
      method: 'POST',
      url: `/v1/documents/${id}/correct`,
      payload: body as object,
      headers: {
        ...auth(key),
        ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
      },
    });
  const fixed = { ...FE_BODY, items: [{ ...FE_BODY.items[0], unitPrice: 500_000 }] };

  let writer: string;
  let reader: string;
  let other: string;

  beforeEach(async () => {
    process.env.SIFEN_ENVIRONMENT = 'production';
    handle = createPgliteDatabase();
    await handle.migrate();
    writer = await seedTenant('Acme SA', ['documents:write', 'documents:read']);
    reader = await seedTenant('Reader SA', ['documents:read']);
    other = await seedTenant('Other SA', ['documents:write']);
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

  it('answers 202 with the same document and CDC and requeues the row', async () => {
    const { documentId, cdc } = await create(writer);

    const response = await correct(documentId, writer, fixed, 'fix-1');

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ document_id: documentId, cdc });
    const [row] = await handle.db.select().from(documents).where(eq(documents.id, documentId));
    expect(row.status).toBe('accepted');
    expect(row.correctionsCount).toBe(1);
    const again = await correct(documentId, writer, fixed, 'fix-1');
    expect(again.statusCode).toBe(202);
    expect(again.json()).toEqual(response.json());
  });

  it('answers 409 for a document that is not rejected or a reused key with another body', async () => {
    const { documentId } = await create(writer, 'approved');
    expect((await correct(documentId, writer, fixed, 'fix-1')).statusCode).toBe(409);
    const rejected = await create(writer);
    await correct(rejected.documentId, writer, fixed, 'fix-2');
    const other_body = { ...fixed, items: [{ ...FE_BODY.items[0], unitPrice: 400_000 }] };
    expect((await correct(rejected.documentId, writer, other_body, 'fix-2')).statusCode).toBe(409);
  });

  it('answers 422 when the type changes or the body is invalid', async () => {
    const { documentId } = await create(writer);
    const note = { type: 'NCE', establishment: '001', expeditionPoint: '002' };
    expect((await correct(documentId, writer, note, 'fix-1')).statusCode).toBe(422);
    expect((await correct(documentId, writer, { ...fixed, items: [] }, 'fix-2')).statusCode).toBe(
      422,
    );
  });

  it('answers 422 for a remission note, which is not correctable', async () => {
    const { documentId } = await create(writer);
    const place = { department: 1, district: 1, city: 1, cityCode: 1, address: 'Ruta 1' };
    const remission = {
      type: 'NRE',
      establishment: '001',
      expeditionPoint: '001',
      motive: 1,
      responsible: 1,
      km: 120,
      receiver: { ruc: '80000002-1', name: 'Receptor Prueba SA', ...place },
      transport: {
        type: 1,
        modality: 1,
        freightResponsible: 1,
        startDate: '2026-10-01',
        endDate: '2026-10-02',
        departure: place,
        delivery: place,
        vehicle: { type: 'Camion', brand: 'Volvo', idType: 1, idNumber: 'ABC12345' },
        carrier: {
          contributor: true,
          name: 'Transportes SA',
          ruc: '80000003-0',
          address: 'Ruta 2 km 10',
          driver: { name: 'Pedro Gomez', idNumber: '1234567', address: 'Calle 9' },
        },
      },
      items: [{ code: 'A-1', description: 'Maíz', unitCode: 77, quantity: 3 }],
    };
    expect((await correct(documentId, writer, remission, 'fix-nre')).statusCode).toBe(422);
  });

  it('answers 422 when a correction that needs a new number targets an unconfigured point', async () => {
    const { documentId } = await create(writer);
    const moved = { ...fixed, expeditionPoint: '003' };
    expect((await correct(documentId, writer, moved, 'fix-1')).statusCode).toBe(422);
  });

  it('answers 400 without a key or a malformed id, 404 for another tenant, 403 for a read-only key', async () => {
    const { documentId } = await create(writer);
    expect((await correct(documentId, writer, fixed)).statusCode).toBe(400);
    expect((await correct('nope', writer, fixed, 'k')).statusCode).toBe(400);
    expect((await correct(documentId, other, fixed, 'k-1')).statusCode).toBe(404);
    expect((await correct(documentId, reader, fixed, 'k-2')).statusCode).toBe(403);
  });
});
