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

const LINE = { code: 'A-001', description: 'Servicio de consultoria', unitCode: 77 };

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
  items: [{ ...LINE, quantity: 1, unitPrice: 110_000, vatRate: 10 }],
  roundingPyg: 0,
  location: { departmentCode: 1 },
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
    app = await buildApp();
  });

  async function buildApp() {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(DATABASE_HANDLE)
      .useValue(handle)
      .overrideProvider(DATABASE)
      .useValue(handle.db)
      .compile();
    const created = moduleRef.createNestApplication<NestFastifyApplication>(createHttpAdapter());
    await created.init();
    await created.getHttpAdapter().getInstance().ready();
    return created;
  }

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

  it('keeps accepting an FE with the explicit `type: FE` discriminator', async () => {
    expect((await post({ ...BODY, type: 'FE' })).statusCode).toBe(202);
  });

  it('answers 422 for an unknown `type` without consuming a number', async () => {
    const response = await post({ ...BODY, type: 'XYZ' });

    expect(response.statusCode).toBe(422);
    expect(response.json<{ errors: Array<{ field: string }> }>().errors).toEqual([
      expect.objectContaining({ field: 'type', rule: 'schema' }),
    ]);
    expect(await handle.db.select().from(documents)).toHaveLength(0);
  });

  it('validates a credit note body, then refuses an FE that does not exist (2403)', async () => {
    const credit = {
      type: 'NCE',
      establishment: '001',
      expeditionPoint: '002',
      associatedCdc: '01800695631001002000000112026010111234567891',
      reasonCode: 2,
      items: [{ ...LINE, quantity: 1, unitPrice: 400_000, vatRate: 10 }],
    };

    const malformed = await post({ ...credit, reasonCode: 'x', receiver: { kind: 'unnamed' } });
    expect(malformed.statusCode).toBe(422);
    expect(
      malformed
        .json<{ errors: Array<{ field: string }> }>()
        .errors.map((e) => e.field)
        .sort(),
    ).toEqual(['reasonCode', 'receiver']);

    const valid = await post(credit);
    expect(valid.statusCode).toBe(422);
    expect(valid.json<{ errors: Array<{ rule: string }> }>().errors).toEqual([
      expect.objectContaining({ rule: 'associated-document-not-found', sifenCode: '2403' }),
    ]);
    expect(await handle.db.select().from(documents)).toHaveLength(0);
  });

  describe('credit notes', () => {
    const nce = (cdc: string) => ({
      type: 'NCE',
      establishment: '001',
      expeditionPoint: '002',
      associatedCdc: cdc,
      reasonCode: 2,
      items: [{ ...LINE, quantity: 1, unitPrice: 50_000, vatRate: 10 }],
    });

    it('accepts an NCE of an approved FE with 202, a 05 CDC and its own number', async () => {
      const fe = (await post(BODY)).json<{ document_id: string; cdc: string }>();
      for (const status of ['signed', 'submitted', 'approved']) {
        await handle.db.update(documents).set({ status }).where(eq(documents.id, fe.document_id));
      }

      const response = await post(nce(fe.cdc));

      expect(response.statusCode).toBe(202);
      const { document_id: id, cdc } = response.json<{ document_id: string; cdc: string }>();
      expect(cdc).toMatch(/^05\d{42}$/);
      const [row] = await handle.db.select().from(documents).where(eq(documents.id, id));
      expect(row).toMatchObject({
        documentType: 5,
        number: 1,
        associatedCdc: fe.cdc,
        status: 'accepted',
      });
    });

    it('answers 422 with the credit note rule when the FE is not approved yet, burning no number', async () => {
      const fe = (await post(BODY)).json<{ cdc: string }>();

      const response = await post(nce(fe.cdc));

      expect(response.statusCode).toBe(422);
      expect(response.json<{ errors: Array<{ rule: string }> }>().errors).toEqual([
        expect.objectContaining({ rule: 'associated-document-not-approved' }),
      ]);
      expect(
        (await handle.db.select().from(documents)).filter((d) => d.documentType === 5),
      ).toEqual([]);
    });

    it('replays an NCE with the same Idempotency-Key and refuses another body with 409', async () => {
      const fe = (await post(BODY)).json<{ document_id: string; cdc: string }>();
      for (const status of ['signed', 'submitted', 'approved']) {
        await handle.db.update(documents).set({ status }).where(eq(documents.id, fe.document_id));
      }
      const first = await post(nce(fe.cdc), bearer, 'nce-key');
      const again = await post(nce(fe.cdc), bearer, 'nce-key');
      expect(again.json()).toEqual(first.json());
      const other = { ...nce(fe.cdc), reasonCode: 3 };
      expect((await post(other, bearer, 'nce-key')).statusCode).toBe(409);
    });
  });

  describe('debit notes', () => {
    const nde = (cdc: string) => ({
      type: 'NDE',
      establishment: '001',
      expeditionPoint: '002',
      associatedCdc: cdc,
      reasonCode: 2,
      items: [{ ...LINE, quantity: 1, unitPrice: 50_000, vatRate: 10 }],
    });
    const approvedFe = async () => {
      const fe = (await post(BODY)).json<{ document_id: string; cdc: string }>();
      for (const status of ['signed', 'submitted', 'approved']) {
        await handle.db.update(documents).set({ status }).where(eq(documents.id, fe.document_id));
      }
      return fe;
    };

    it('accepts an NDE of an approved FE with 202, a 06 CDC and its own number', async () => {
      const fe = await approvedFe();

      const response = await post(nde(fe.cdc));

      expect(response.statusCode).toBe(202);
      const { document_id: id, cdc } = response.json<{ document_id: string; cdc: string }>();
      expect(cdc).toMatch(/^06\d{42}$/);
      const [row] = await handle.db.select().from(documents).where(eq(documents.id, id));
      expect(row).toMatchObject({
        documentType: 6,
        number: 1,
        associatedCdc: fe.cdc,
        status: 'accepted',
      });
    });

    it('refuses an FE that does not exist (2403) and one not approved yet, burning no number', async () => {
      const missing = await post(nde('01800695631001002000000112026010111234567891'));
      expect(missing.statusCode).toBe(422);
      expect(missing.json<{ errors: Array<{ rule: string }> }>().errors).toEqual([
        expect.objectContaining({ rule: 'associated-document-not-found' }),
      ]);
      const fe = (await post(BODY)).json<{ cdc: string }>();
      const pending = await post(nde(fe.cdc));
      expect(pending.statusCode).toBe(422);
      expect(
        (await handle.db.select().from(documents)).filter((d) => d.documentType === 6),
      ).toEqual([]);
    });

    it('replays an NDE with the same Idempotency-Key and refuses another body with 409', async () => {
      const fe = await approvedFe();
      const first = await post(nde(fe.cdc), bearer, 'nde-key');
      const again = await post(nde(fe.cdc), bearer, 'nde-key');
      expect(again.json()).toEqual(first.json());
      expect((await post({ ...nde(fe.cdc), reasonCode: 3 }, bearer, 'nde-key')).statusCode).toBe(
        409,
      );
    });
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
      items: [{ ...LINE, quantity: 1, unitPrice: 8_000_000, vatRate: 10 }],
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
      items: [{ ...LINE, quantity: 1, unitPrice: 1e20, vatRate: 10 }],
    });

    expect(response.statusCode).toBe(422);
    expect(
      response.json<{ errors: Array<{ rule: string }> }>().errors.map((e) => e.rule),
    ).toContain('amount-range');
  });

  it('caps the items at 999 (MT v150 E001 gCamItem 1-999)', async () => {
    const item = { ...LINE, quantity: 1, unitPrice: 50, vatRate: 10 };

    const response = await post({ ...BODY, items: Array.from({ length: 1000 }, () => item) });

    expect(response.statusCode).toBe(422);
    expect(response.json<{ errors: Array<{ field: string }> }>().errors[0]?.field).toBe('items');
  });

  it('rejects a body over the 1 MiB limit with 413', async () => {
    const response = await post({ ...BODY, note: 'x'.repeat(1_048_576) });

    expect(response.statusCode).toBe(413);
  });

  it('accepts an unnamed receiver that still sends the department (legacy clients)', async () => {
    const response = await post({
      ...BODY,
      operationType: 'B2C',
      receiver: { kind: 'unnamed' },
      location: { departmentCode: 1 },
    });

    expect(response.statusCode).toBe(202);
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

  it('answers 422 naming every missing receiver and item field of the DE XML', async () => {
    const response = await post({
      ...BODY,
      receiver: { kind: 'named', ruc: '80069563-1' },
      items: [{ quantity: 1, unitPrice: 110_000, vatRate: 10 }],
    });

    expect(response.statusCode).toBe(422);
    const { errors } = response.json<{ errors: Array<{ field: string }> }>();
    expect(errors.map((e) => e.field)).toEqual(
      expect.arrayContaining(['receiver.name', 'items[0].code', 'items[0].unitCode']),
    );
    expect(await handle.db.select().from(documents)).toHaveLength(0);
  });

  it('accepts a named receiver without address block and without location (D213 occurs 0-1)', async () => {
    const response = await post({
      ...BODY,
      receiver: { kind: 'named', ruc: '80069563-1', name: 'Cliente SA' },
      location: undefined,
    });

    expect(response.statusCode).toBe(202);
  });

  it('answers 422 receiver-address-required (4478) for B2F without address', async () => {
    const response = await post({
      ...BODY,
      operationType: 'B2F',
      receiver: { kind: 'named', ruc: '80069563-1', name: 'Cliente SA' },
      location: undefined,
    });

    expect(response.statusCode).toBe(422);
    expect(response.json<{ errors: Array<{ rule: string }> }>().errors).toContainEqual(
      expect.objectContaining({ rule: 'receiver-address-required' }),
    );
    expect(await handle.db.select().from(documents)).toHaveLength(0);
  });

  it.each(['B2G', 'B2F'] as const)(
    'answers 422 operation-type-not-supported for %s and consumes no number',
    async (operationType) => {
      const response = await post({
        ...BODY,
        operationType,
        receiver:
          operationType === 'B2F'
            ? {
                kind: 'named',
                ruc: '80069563-1',
                name: 'Cliente SA',
                address: 'Main St 1',
                houseNumber: '1',
              }
            : BODY.receiver,
        location: operationType === 'B2F' ? undefined : BODY.location,
      });

      expect(response.statusCode).toBe(422);
      expect(response.json<{ errors: Array<{ rule: string }> }>().errors).toContainEqual(
        expect.objectContaining({ rule: 'operation-type-not-supported' }),
      );
      expect(await handle.db.select().from(documents)).toHaveLength(0);
      expect(await handle.db.select().from(tenantDocumentSequences)).toHaveLength(0);
    },
  );

  it('stores the receiver and item XML data in the payload', async () => {
    const response = await post(BODY);

    const { document_id: id } = response.json<{ document_id: string }>();
    const [row] = await handle.db.select().from(documents).where(eq(documents.id, id));
    expect(row.payload).toMatchObject({
      receiver: { name: 'Cliente SA', districtCode: 1 },
      items: [{ code: 'A-001', unitCode: 77 }],
    });
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

  describe('self-invoices (HU-E7-03)', () => {
    const place = {
      address: 'Calle 1',
      houseNumber: '10',
      departmentCode: 11,
      districtCode: 143,
      cityCode: 3344,
    };
    const AFE = {
      type: 'AFE',
      establishment: '001',
      expeditionPoint: '002',
      seller: { nature: 1, idType: 1, idNumber: '1234567', name: 'Juan Perez', ...place },
      place,
      certificate: { type: 1, number: '12345678901', control: 'ABCD1234' },
      items: [{ ...LINE, quantity: 2, unitPrice: 50_000 }],
    };

    it('accepts an AFE with 202, a 04 CDC and its own number sequence', async () => {
      const response = await post(AFE);

      expect(response.statusCode).toBe(202);
      const { document_id: id, cdc } = response.json<{ document_id: string; cdc: string }>();
      expect(cdc).toMatch(/^04\d{42}$/);
      const [row] = await handle.db.select().from(documents).where(eq(documents.id, id));
      expect(row).toMatchObject({
        documentType: 4,
        number: 1,
        associatedCdc: null,
        status: 'accepted',
      });
    });

    it('answers 422 naming the field of the rule that failed, burning no number', async () => {
      const response = await post({
        ...AFE,
        certificate: { type: 1, number: '123', control: 'ABCD1234' },
      });

      expect(response.statusCode).toBe(422);
      expect(response.json<{ errors: Array<{ rule: string }> }>().errors).toEqual([
        expect.objectContaining({ rule: 'self-invoice-certificate-number' }),
      ]);
      expect(
        (await handle.db.select().from(documents)).filter((d) => d.documentType === 4),
      ).toEqual([]);
    });

    it('rejects a receiver in the body (it is the issuer) with 422', async () => {
      const response = await post({ ...AFE, receiver: { kind: 'unnamed' } });
      expect(response.statusCode).toBe(422);
    });

    it('replays an AFE with the same Idempotency-Key and refuses another body with 409', async () => {
      const first = await post(AFE, bearer, 'afe-key');
      const again = await post(AFE, bearer, 'afe-key');
      expect(again.json()).toEqual(first.json());
      const other = { ...AFE, items: [{ ...LINE, quantity: 3, unitPrice: 50_000 }] };
      expect((await post(other, bearer, 'afe-key')).statusCode).toBe(409);
    });
  });

  describe('remission notes (HU-E7-04)', () => {
    const place = {
      address: 'Calle 1',
      houseNumber: '10',
      departmentCode: 11,
      districtCode: 143,
      cityCode: 3344,
    };
    const NRE = {
      type: 'NRE',
      establishment: '001',
      expeditionPoint: '002',
      motive: 1,
      responsible: 1,
      km: 120,
      receiver: { ruc: '80000001-3', name: 'Empresa Real SA', ...place },
      transport: {
        type: 1,
        modality: 1,
        freightResponsible: 1,
        startDate: '2026-11-02',
        endDate: '2026-11-03',
        departure: place,
        delivery: place,
        vehicle: { type: 'Camion', brand: 'Volvo', idType: 1, idNumber: 'ABC123' },
        carrier: {
          contributor: true,
          name: 'Transportes SA',
          ruc: '80000002-1',
          address: 'Ruta 1',
          driver: { name: 'Pedro Gomez', idNumber: '2345678', address: 'Calle 3' },
        },
      },
      items: [{ code: 'M-1', description: 'Maiz', unitCode: 77, quantity: 2 }],
    };

    it('accepts an NRE with 202, a 07 CDC and its own number sequence', async () => {
      const response = await post(NRE);

      expect(response.statusCode).toBe(202);
      const { document_id: id, cdc } = response.json<{ document_id: string; cdc: string }>();
      expect(cdc).toMatch(/^07\d{42}$/);
      const [row] = await handle.db.select().from(documents).where(eq(documents.id, id));
      expect(row).toMatchObject({
        documentType: 7,
        number: 1,
        associatedCdc: null,
        receiverRuc: '80000001-3',
        status: 'accepted',
      });
    });

    it('answers 422 naming the rule that failed, burning no number', async () => {
      const response = await post({ ...NRE, motive: 77 });

      expect(response.statusCode).toBe(422);
      expect(response.json<{ errors: Array<{ rule: string }> }>().errors).toEqual([
        expect.objectContaining({ rule: expect.stringContaining('motive') as string }),
      ]);
      expect(
        (await handle.db.select().from(documents)).filter((d) => d.documentType === 7),
      ).toEqual([]);
    });

    it('refuses motive 7 addressed to another RUC (2606)', async () => {
      const response = await post({ ...NRE, motive: 7 });
      expect(response.statusCode).toBe(422);
      expect(response.json<{ errors: Array<{ sifenCode?: string }> }>().errors[0]).toMatchObject({
        sifenCode: '2606',
      });
    });

    it('replays an NRE with the same Idempotency-Key and refuses another body with 409', async () => {
      const first = await post(NRE, bearer, 'nre-key');
      const again = await post(NRE, bearer, 'nre-key');
      expect(again.json()).toEqual(first.json());
      expect((await post({ ...NRE, km: 130 }, bearer, 'nre-key')).statusCode).toBe(409);
    });
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
        { ...BODY, items: [{ ...LINE, quantity: 2, unitPrice: 110_000, vatRate: 10 }] },
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

  /** HU-E6-06: `?wait=true` only holds the response for a tenant with the synchronous flag. */
  describe('?wait=true', () => {
    const originalTimeout = process.env.SYNC_WAIT_TIMEOUT_MS;
    afterEach(() => {
      if (originalTimeout === undefined) delete process.env.SYNC_WAIT_TIMEOUT_MS;
      else process.env.SYNC_WAIT_TIMEOUT_MS = originalTimeout;
    });
    const flagOn = () =>
      handle.db
        .update(tenantFiscalProfiles)
        .set({ syncTransmission: true })
        .where(eq(tenantFiscalProfiles.tenantId, tenantId));
    const postWait = (key: string) =>
      app.inject({
        method: 'POST',
        url: '/v1/documents?wait=true',
        payload: BODY,
        headers: { authorization: `Bearer ${bearer}`, 'idempotency-key': key },
      });

    it('answers the usual 202 at once for a tenant without the flag', async () => {
      const response = await postWait('wait-1');
      expect(response.statusCode).toBe(202);
      expect(response.json<{ document_id: string }>().document_id).toBeDefined();
    });

    it('answers 200 with the final document once SIFEN settles it', async () => {
      await flagOn();
      const pending = postWait('wait-2');
      // The worker would walk the document through these; here a timer stands in for it.
      const steps = ['signed', 'submitted', 'approved'];
      const settle = setInterval(() => {
        const status = steps.shift();
        if (status) {
          void Promise.resolve(handle.db.update(documents).set({ status }));
        }
      }, 200);
      const response = await pending;
      clearInterval(settle);
      expect(response.statusCode).toBe(200);
      expect(response.json<{ status: string; cdc: string }>()).toMatchObject({
        status: 'approved',
        cdc: expect.stringMatching(/^\d{44}$/) as string,
      });
    });

    it('falls back to 202 when the document is not final by the timeout', async () => {
      process.env.SYNC_WAIT_TIMEOUT_MS = '1000';
      const short = await buildApp();
      await flagOn();
      const response = await short.inject({
        method: 'POST',
        url: '/v1/documents?wait=true',
        payload: BODY,
        headers: { authorization: `Bearer ${bearer}`, 'idempotency-key': 'wait-3' },
      });
      expect(response.statusCode).toBe(202);
      await short.close();
    });

    it('refuses to boot with an out-of-range SYNC_WAIT_TIMEOUT_MS', async () => {
      process.env.SYNC_WAIT_TIMEOUT_MS = '50';
      await expect(buildApp()).rejects.toThrow(/SYNC_WAIT_TIMEOUT_MS/);
    });
  });
});
