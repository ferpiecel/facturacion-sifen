import { type NestFastifyApplication } from '@nestjs/platform-fastify';
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
import { createHttpAdapter } from '../src/bootstrap/http.js';
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

  async function seedTenant(name: string, withIssuer: boolean, scopes = ['documents:write']) {
    const { id } = await createTenant(handle.db, name);
    const { formattedKey } = await issueApiKey(handle.db, {
      tenantId: id,
      environment: 'live',
      scopes,
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
    app = moduleRef.createNestApplication<NestFastifyApplication>(createHttpAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterEach(async () => {
    await app.close();
    if (originalEnvironment === undefined) delete process.env.SIFEN_ENVIRONMENT;
    else process.env.SIFEN_ENVIRONMENT = originalEnvironment;
  });

  let sequence = 0;
  /** Posts with a fresh `Idempotency-Key` unless one is given (`null` omits the header). */
  const post = (
    body: unknown,
    key: string | null = bearer,
    idempotencyKey: string | null = `auto-${String(++sequence)}`,
  ) =>
    app.inject({
      method: 'POST',
      url: '/v1/documents',
      payload: body as object,
      headers: {
        ...(key ? { authorization: `Bearer ${key}` } : {}),
        ...(idempotencyKey === null ? {} : { 'idempotency-key': idempotencyKey }),
      },
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

  it('gives each tenant its own document when both use the same establishment and point codes', async () => {
    const other = await seedTenant('Other SA', true);

    const mine = await post(BODY);
    const theirs = await post(BODY, other.formattedKey);

    expect([mine.statusCode, theirs.statusCode]).toEqual([202, 202]);
    const rows = await handle.db.select().from(documents);
    expect(rows.map((row) => row.tenantId).sort()).toEqual([tenantId, other.id].sort());
    expect(new Set(rows.map((row) => row.id)).size).toBe(2);
  });

  it('answers 403 for a key without the documents:write scope', async () => {
    const readOnly = await seedTenant('Read SA', true, ['documents:read']);

    expect((await post(BODY, readOnly.formattedKey)).statusCode).toBe(403);
    expect(await handle.db.select().from(documents)).toHaveLength(0);
  });

  it('persists the validated body (defaults applied, unknown keys stripped), not the raw one', async () => {
    const response = await post({ ...BODY, roundingPyg: undefined, injected: 'x'.repeat(10) });

    expect(response.statusCode).toBe(202);
    const [row] = await handle.db.select().from(documents);
    expect(row.payload).toMatchObject({ roundingPyg: 0, currency: 'PYG' });
    expect(row.payload).not.toHaveProperty('injected');
  });

  it('answers 422 amount-range for amounts beyond the numeric column, never a 500', async () => {
    const response = await post({
      ...BODY,
      items: [{ quantity: 1, unitPrice: 1e20, vatRate: 10 }],
    });

    expect(response.statusCode).toBe(422);
    expect(
      response.json<{ errors: Array<{ rule: string }> }>().errors.map((e) => e.rule),
    ).toContain('amount-range');
  });

  it('caps the items at 999 (MT v150 E001 gCamItem 1-999)', async () => {
    const item = { quantity: 1, unitPrice: 50, vatRate: 10 };

    const response = await post({ ...BODY, items: Array.from({ length: 1000 }, () => item) });

    expect(response.statusCode).toBe(422);
    expect(response.json<{ errors: Array<{ field: string }> }>().errors[0]?.field).toBe('items');
  });

  it('rejects a body over the 1 MiB limit with 413', async () => {
    const response = await post({ ...BODY, note: 'x'.repeat(1_048_576) });

    expect(response.statusCode).toBe(413);
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

  describe('Idempotency-Key (HU-E5-02)', () => {
    it('answers 400 when the header is missing or malformed, persisting nothing', async () => {
      for (const key of [null, '', 'k'.repeat(256), 'has space']) {
        const response = await post(BODY, bearer, key);
        expect(response.statusCode).toBe(400);
        expect(response.json<{ message: string }>().message).toContain('Idempotency-Key');
      }
      expect(await handle.db.select().from(documents)).toHaveLength(0);
    });

    it('replays the same 202 body for a retry and creates a single document', async () => {
      const first = await post(BODY, bearer, 'retry-1');
      const second = await post(BODY, bearer, 'retry-1');

      expect([first.statusCode, second.statusCode]).toEqual([202, 202]);
      expect(second.json()).toEqual(first.json());
      expect(await handle.db.select().from(documents)).toHaveLength(1);
    });

    it('answers 409 when the same key arrives with a different payload', async () => {
      await post(BODY, bearer, 'retry-2');

      const response = await post(
        { ...BODY, items: [{ quantity: 2, unitPrice: 110_000, vatRate: 10 }] },
        bearer,
        'retry-2',
      );

      expect(response.statusCode).toBe(409);
      expect(response.json<{ message: string }>().message).toMatch(/Idempotency-Key/);
      expect(await handle.db.select().from(documents)).toHaveLength(1);
    });

    it('treats defaults and key order as the same request (canonical hash of the validated body)', async () => {
      const first = await post(BODY, bearer, 'retry-3');
      const reordered = Object.fromEntries(Object.entries(BODY).reverse());
      const second = await post({ ...reordered, currency: 'PYG' }, bearer, 'retry-3');

      expect(second.statusCode).toBe(202);
      expect(second.json()).toEqual(first.json());
    });

    it('creates one document when two identical requests race', async () => {
      const [a, b] = await Promise.all([
        post(BODY, bearer, 'race-1'),
        post(BODY, bearer, 'race-1'),
      ]);

      expect([a.statusCode, b.statusCode]).toEqual([202, 202]);
      expect(a.json()).toEqual(b.json());
      expect(await handle.db.select().from(documents)).toHaveLength(1);
    });

    it('scopes the key per tenant', async () => {
      const other = await seedTenant('Other SA', true);

      const mine = await post(BODY, bearer, 'same-key');
      const theirs = await post(BODY, other.formattedKey, 'same-key');

      expect([mine.statusCode, theirs.statusCode]).toEqual([202, 202]);
      expect(mine.json<{ cdc: string }>().cdc).not.toBe(theirs.json<{ cdc: string }>().cdc);
      expect(await handle.db.select().from(documents)).toHaveLength(2);
    });

    it('does not consume the key when the request fails validation', async () => {
      const bad = await post({ ...BODY, items: [] }, bearer, 'retry-4');
      expect(bad.statusCode).toBe(422);

      const good = await post(BODY, bearer, 'retry-4');
      expect(good.statusCode).toBe(202);
    });
  });
});
