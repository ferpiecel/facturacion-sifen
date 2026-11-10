import { randomUUID } from 'node:crypto';
import { type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import {
  auditLog,
  createPgliteDatabase,
  receivedDocumentItems,
  receivedDocuments,
  type DatabaseHandle,
} from '@sifen/db';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { createHttpAdapter } from '../src/bootstrap/http.js';
import { createTenant, issueApiKey } from '../src/cli/commands.js';
import { DATABASE, DATABASE_HANDLE } from '../src/modules/database/database.module.js';
import { computeRucCheckDigit } from '../src/modules/fiscal-config/domain/ruc.js';
import { createReceivedDocument } from '../src/modules/reception/domain/received-document.js';
import { createDrizzleReceivedDocumentRepository } from '../src/modules/reception/infrastructure/adapters/drizzle-received-document-repository.js';
import { InMemoryStorageProvider } from '../src/modules/reception/infrastructure/adapters/in-memory-storage-provider.js';
import { RECEPTION_STORAGE } from '../src/modules/reception/reception.tokens.js';

interface Body {
  id: string;
  status: string;
  version: number;
  needs_review_reasons: string[];
  totals: { total_amount: string };
  items: { position: number; subtotal: string }[];
  corrected_by: string | null;
  confirmed_by: string | null;
  code?: string;
  reasons?: string[];
  current_version?: number;
  field_confidences: { field: string; corrected_value: string | null }[];
}

const ISSUER = '80000000';

/** Spec: reception R4.4. `PATCH /v1/received-documents/{id}`: correct and confirm in one call. */
describe('PATCH /v1/received-documents/{id} (e2e)', () => {
  let handle: DatabaseHandle;
  let app: NestFastifyApplication;
  let tenantA: string;
  let tenantB: string;
  let writeA: string;
  let writeApiKeyId: string;
  let writeB: string;
  let readA: string;
  const originalEnvironment = process.env.SIFEN_ENVIRONMENT;

  const patch = (key: string, id: string, payload: unknown) =>
    app.inject({
      method: 'PATCH',
      url: `/v1/received-documents/${id}`,
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      payload: JSON.stringify(payload),
    });
  const detail = async (id: string) =>
    (
      await app.inject({
        method: 'GET',
        url: `/v1/received-documents/${id}`,
        headers: { authorization: `Bearer ${readA}` },
      })
    ).json<Body>();

  /** A needs_review document whose declared total (100) disagrees with its blocks (110000). */
  const seed = async (tenantId: string, status: 'needs_review' | 'extracting' = 'needs_review') => {
    const id = randomUUID();
    await createDrizzleReceivedDocumentRepository(handle.db).create(tenantId, {
      document: createReceivedDocument({ id, tenantId, source: 'sifen_xml', isOwnReceiver: true }),
      header: {
        issuerRucBase: ISSUER,
        issuerRucDv: computeRucCheckDigit(ISSUER),
        issuerLegalName: 'ACME',
        establishmentCode: '001',
        expeditionPointCode: '001',
        documentNumber: '0000001',
        issuedAt: new Date('2026-11-06T00:00:00.000Z'),
        taxable10: '100000',
        vat10: '10000',
        totalAmount: '100',
      },
      items: [1, 2].map((position) => ({
        position,
        description: `Line ${String(position)}`,
        productCode: null,
        quantity: '1',
        unitOfMeasure: null,
        unitPrice: '55000',
        discount: null,
        subtotal: '55000',
        vatRate: 10 as const,
        taxableBase: null,
        vatAmount: null,
      })),
      confidences: ['totals', 'items'].map((fieldName) => ({
        fieldName,
        confidence: '1.0',
        extractedValue: null,
        correctedValue: null,
        correctedBy: null,
        correctedAt: null,
      })),
    });
    await handle.db
      .update(receivedDocuments)
      .set(
        status === 'needs_review'
          ? { status, needsReview: true, needsReviewReasons: ['totals_blocks_sum_mismatch'] }
          : { status },
      )
      .where(eq(receivedDocuments.id, id));
    return id;
  };

  beforeEach(async () => {
    process.env.SIFEN_ENVIRONMENT = 'production';
    handle = createPgliteDatabase();
    await handle.migrate();
    tenantA = (await createTenant(handle.db, 'Acme SA')).id;
    tenantB = (await createTenant(handle.db, 'Beta SA')).id;
    const key = (tenantId: string, scopes: string[]) =>
      issueApiKey(handle.db, { tenantId, environment: 'live', scopes });
    const issued = await key(tenantA, ['reception:write', 'reception:read']);
    writeA = issued.formattedKey;
    writeApiKeyId = issued.apiKeyId;
    writeB = (await key(tenantB, ['reception:write'])).formattedKey;
    readA = (await key(tenantA, ['reception:read'])).formattedKey;
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(DATABASE_HANDLE)
      .useValue(handle)
      .overrideProvider(DATABASE)
      .useValue(handle.db)
      .overrideProvider(RECEPTION_STORAGE)
      .useValue(new InMemoryStorageProvider())
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

  it('corrects and confirms in one request, returning the detail shape', async () => {
    const id = await seed(tenantA);
    const response = await patch(writeA, id, {
      version: 1,
      confirm: true,
      totals: { total_amount: '110000' },
      items: [
        { position: 1, subtotal: '60000' },
        { position: 2, remove: true },
        { position: 3, subtotal: '50000' },
      ],
    });
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json<Body>();
    expect(body).toMatchObject({
      id,
      status: 'confirmed',
      version: 2,
      corrected_by: writeApiKeyId,
    });
    expect(body.confirmed_by).toBe(writeApiKeyId);
    expect(body.totals.total_amount).toBe('110000');
    expect(body.items.map((i) => [i.position, i.subtotal])).toEqual([
      [1, '60000'],
      [3, '50000'],
    ]);
    expect(body.field_confidences.find((c) => c.field === 'totals')?.corrected_value).toContain(
      '110000',
    );
    expect(await detail(id)).toMatchObject({ status: 'confirmed', version: 2 });

    const rows = await handle.db.select().from(receivedDocumentItems);
    expect(rows).toHaveLength(3);
    const audit = await handle.db.select().from(auditLog).where(eq(auditLog.entityId, id));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      action: 'received_document.confirmed',
      actorId: writeApiKeyId,
      tenantId: tenantA,
    });
  });

  it('keeps needs_review when not confirming and refreshes the reasons', async () => {
    const id = await seed(tenantA);
    const body = (
      await patch(writeA, id, { version: 1, totals: { total_amount: '110000' } })
    ).json<Body>();
    expect(body).toMatchObject({ status: 'needs_review', version: 2 });
    expect(body.needs_review_reasons).toEqual(['awaiting_confirmation']);
  });

  it('answers 409 version_conflict with the current version', async () => {
    const id = await seed(tenantA);
    const response = await patch(writeA, id, { version: 7, totals: { total_amount: '5' } });
    expect(response.statusCode).toBe(409);
    expect(response.json<Body>()).toMatchObject({ code: 'version_conflict', current_version: 1 });
    expect((await detail(id)).totals.total_amount).toBe('100');
  });

  it('answers 422 validation_failed with reason codes and writes nothing', async () => {
    const id = await seed(tenantA);
    const response = await patch(writeA, id, {
      version: 1,
      confirm: true,
      issuer: { legal_name: 'Renamed' },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json<Body>()).toMatchObject({ code: 'validation_failed' });
    expect(response.json<Body>().reasons).toContain('totals_blocks_sum_mismatch');
    const after = await detail(id);
    expect(after).toMatchObject({ status: 'needs_review', version: 1 });
    expect(await handle.db.select().from(auditLog)).toHaveLength(0);
  });

  it('replays the same request idempotently without bumping the version', async () => {
    const id = await seed(tenantA);
    const request = {
      version: 1,
      confirm: true,
      totals: { total_amount: '110000' },
      items: [
        { position: 1, subtotal: '110000' },
        { position: 2, remove: true },
      ],
    };
    const first = await patch(writeA, id, request);
    expect(first.statusCode, first.body).toBe(200);
    const replay = await patch(writeA, id, request);
    expect(replay.statusCode).toBe(200);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.json<Body>().version).toBe(first.json<Body>().version);
    expect(await handle.db.select().from(auditLog)).toHaveLength(1);
  });

  it('answers 409 invalid_state for a document still being processed', async () => {
    const id = await seed(tenantA, 'extracting');
    const response = await patch(writeA, id, { version: 1, totals: { total_amount: '1' } });
    expect(response.statusCode).toBe(409);
    expect(response.json<Body>()).toMatchObject({ code: 'invalid_state' });
  });

  it('answers 404 for unknown ids and for another tenant document', async () => {
    const id = await seed(tenantA);
    for (const [key, target] of [
      [writeA, randomUUID()],
      [writeB, id],
    ] as const) {
      const response = await patch(key, target, { version: 1, confirm: true });
      expect(response.statusCode).toBe(404);
      expect(response.json<Body>().code).toBe('not_found');
    }
    expect((await detail(id)).version).toBe(1);
  });

  it('requires the reception:write scope', async () => {
    const id = await seed(tenantA);
    expect((await patch(readA, id, { version: 1 })).statusCode).toBe(403);
    const anonymous = await app.inject({ method: 'PATCH', url: `/v1/received-documents/${id}` });
    expect(anonymous.statusCode).toBe(401);
  });

  it('rejects malformed bodies with 400 invalid_request', async () => {
    const id = await seed(tenantA);
    const bad: unknown[] = [
      {},
      { version: 0 },
      { version: 1, unknown_field: true },
      { version: 1, totals: { total_amount: 'abc' } },
      { version: 1, totals: { total_amount: 110000 } },
      { version: 1, items: [{ description: 'no position' }] },
      { version: 1, items: [{ position: 1, extra: 1 }] },
      { version: 1, confirm: 'yes' },
    ];
    for (const payload of bad) {
      const response = await patch(writeA, id, payload);
      expect(response.statusCode, JSON.stringify(payload)).toBe(400);
      expect(response.json<Body>().code).toBe('invalid_request');
    }
    expect((await detail(id)).version).toBe(1);
  });

  it('answers 422 invalid_correction for an item position that does not exist', async () => {
    const id = await seed(tenantA);
    const response = await patch(writeA, id, {
      version: 1,
      items: [{ position: 9, remove: true }],
    });
    expect(response.statusCode).toBe(422);
    expect(response.json<Body>().code).toBe('invalid_correction');
  });
});
