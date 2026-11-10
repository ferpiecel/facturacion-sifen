import { createHash, randomUUID } from 'node:crypto';
import { type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { createPgliteDatabase, receivedDocuments, type DatabaseHandle } from '@sifen/db';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { createHttpAdapter } from '../src/bootstrap/http.js';
import { createTenant, issueApiKey } from '../src/cli/commands.js';
import { DATABASE, DATABASE_HANDLE } from '../src/modules/database/database.module.js';
import type { ReceivedDocumentHeaderInput } from '../src/modules/reception/application/ports/received-document-repository.port.js';
import { createReceivedDocument } from '../src/modules/reception/domain/received-document.js';
import { createDrizzleReceivedDocumentRepository } from '../src/modules/reception/infrastructure/adapters/drizzle-received-document-repository.js';
import { InMemoryStorageProvider } from '../src/modules/reception/infrastructure/adapters/in-memory-storage-provider.js';
import { RECEPTION_STORAGE } from '../src/modules/reception/reception.tokens.js';

interface Seed {
  readonly header?: ReceivedDocumentHeaderInput;
  readonly source?: 'sifen_xml' | 'pdf';
  readonly isOwnReceiver?: boolean;
  readonly status?: 'confirmed' | 'needs_review';
  readonly artifact?: { readonly bytes: Buffer; readonly name: string | null };
  readonly items?: boolean;
}

interface Page {
  items: { id: string; status: string }[];
  next_cursor: string | null;
}

const XML = Buffer.from('<?xml version="1.0"?><rDE><DE Id="x"/></rDE>');

/** Spec: reception R4.3. Read side of `/v1/received-documents` (list, detail, artifact). */
describe('GET /v1/received-documents (e2e)', () => {
  let handle: DatabaseHandle;
  let app: NestFastifyApplication;
  let storage: InMemoryStorageProvider;
  let tenantA: string;
  let tenantB: string;
  let readA: string;
  let readB: string;
  let writeOnlyA: string;
  const originalEnvironment = process.env.SIFEN_ENVIRONMENT;

  const get = (key: string, url: string) =>
    app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${key}` } });
  const list = async (query = '', key = readA) => {
    const response = await get(key, `/v1/received-documents${query}`);
    expect(response.statusCode, response.body).toBe(200);
    return response.json<Page>();
  };

  const seed = async (tenantId: string, input: Seed = {}): Promise<string> => {
    const repository = createDrizzleReceivedDocumentRepository(handle.db);
    const id = randomUUID();
    const artifact = input.artifact
      ? {
          storageKey: `sifen_xml/${tenantId}/${id}.xml`,
          contentType: 'application/xml',
          sha256: createHash('sha256').update(input.artifact.bytes).update(id).digest('hex'),
          sizeBytes: input.artifact.bytes.byteLength,
          originalName: input.artifact.name,
          pageCount: null,
        }
      : undefined;
    if (artifact) await storage.upload(artifact.storageKey, input.artifact?.bytes ?? XML);
    await repository.create(tenantId, {
      document: createReceivedDocument({
        id,
        tenantId,
        source: input.source ?? 'sifen_xml',
        isOwnReceiver: input.isOwnReceiver ?? true,
      }),
      header: input.header,
      artifact,
      items: input.items
        ? [
            {
              position: 1,
              description: 'Servicio',
              productCode: 'S1',
              quantity: '2',
              unitOfMeasure: 'UNI',
              unitPrice: '5000',
              discount: null,
              subtotal: '10000',
              vatRate: 10,
              taxableBase: '9091',
              vatAmount: '909',
            },
          ]
        : undefined,
      confidences: input.items
        ? [
            {
              fieldName: 'totals',
              confidence: '0.9',
              extractedValue: '10000',
              correctedValue: null,
              correctedBy: null,
              correctedAt: null,
            },
          ]
        : undefined,
    });
    if (input.status) {
      await handle.db
        .update(receivedDocuments)
        .set({
          status: input.status,
          confirmedAt: input.status === 'confirmed' ? new Date() : null,
          needsReview: input.status === 'needs_review',
          needsReviewReasons: input.status === 'needs_review' ? ['receiver_mismatch'] : [],
        })
        .where(eq(receivedDocuments.id, id));
    }
    return id;
  };

  const boot = async (provider: InMemoryStorageProvider | null) => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(DATABASE_HANDLE)
      .useValue(handle)
      .overrideProvider(DATABASE)
      .useValue(handle.db)
      .overrideProvider(RECEPTION_STORAGE)
      .useValue(provider)
      .compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(createHttpAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  };

  beforeEach(async () => {
    process.env.SIFEN_ENVIRONMENT = 'production';
    handle = createPgliteDatabase();
    await handle.migrate();
    tenantA = (await createTenant(handle.db, 'Acme SA')).id;
    tenantB = (await createTenant(handle.db, 'Beta SA')).id;
    const key = async (tenantId: string, scopes: string[]) =>
      (await issueApiKey(handle.db, { tenantId, environment: 'live', scopes })).formattedKey;
    readA = await key(tenantA, ['reception:read']);
    readB = await key(tenantB, ['reception:read']);
    writeOnlyA = await key(tenantA, ['reception:write']);
    storage = new InMemoryStorageProvider();
    await boot(expect.getState().currentTestName?.includes('is disabled') ? null : storage);
  });

  afterEach(async () => {
    await app.close();
    if (originalEnvironment === undefined) delete process.env.SIFEN_ENVIRONMENT;
    else process.env.SIFEN_ENVIRONMENT = originalEnvironment;
  });

  it('pages newest first with a cursor, without gaps or repeats', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) ids.push(await seed(tenantA));
    await seed(tenantB);

    const first = await list('?limit=2');
    const second = await list(`?limit=2&cursor=${first.next_cursor ?? ''}`);
    const third = await list(`?limit=2&cursor=${second.next_cursor ?? ''}`);

    expect(first.items).toHaveLength(2);
    expect(second.items).toHaveLength(2);
    expect(third.items).toHaveLength(1);
    expect(third.next_cursor).toBeNull();
    expect([...first.items, ...second.items, ...third.items].map((item) => item.id)).toEqual(
      [...ids].reverse(),
    );
  });

  it('filters by status, source, issuer RUC, issued range, receiver ownership and CDC prefix', async () => {
    const cdc = `0180000001${'1'.repeat(34)}`;
    const base = await seed(tenantA, {
      header: { issuerRucBase: '80000002', issuerRucDv: 1, issuedAt: new Date('2026-03-10Z'), cdc },
      status: 'confirmed',
    });
    const other = await seed(tenantA, {
      source: 'pdf',
      isOwnReceiver: false,
      header: { issuerRucBase: '80000003', issuerRucDv: 2, issuedAt: new Date('2026-05-20Z') },
      status: 'needs_review',
    });
    const ids = async (query: string) => (await list(query)).items.map((item) => item.id);

    expect(await ids('?status=confirmed')).toEqual([base]);
    expect(await ids('?status=needs_review')).toEqual([other]);
    expect(await ids('?source=pdf')).toEqual([other]);
    expect(await ids('?issuer_ruc=80000002')).toEqual([base]);
    expect(await ids('?issuer_ruc=80000002-1')).toEqual([base]);
    expect(await ids('?issued_from=2026-04-01')).toEqual([other]);
    expect(await ids('?issued_to=2026-03-10')).toEqual([base]);
    expect(await ids('?issued_from=2026-03-10&issued_to=2026-05-20')).toEqual([other, base]);
    expect(await ids('?is_own_receiver=false')).toEqual([other]);
    expect(await ids('?is_own_receiver=true')).toEqual([base]);
    expect(await ids(`?cdc_prefix=${cdc.slice(0, 12)}`)).toEqual([base]);
  });

  it('returns only documents updated at or after updated_since', async () => {
    const old = await seed(tenantA);
    const recent = await seed(tenantA);
    const stamp = (id: string, at: string) =>
      handle.db
        .update(receivedDocuments)
        .set({ updatedAt: new Date(at) })
        .where(eq(receivedDocuments.id, id));
    await stamp(old, '2026-01-01T00:00:00Z');
    await stamp(recent, '2026-06-01T00:00:00Z');

    const page = await list('?updated_since=2026-03-01T00:00:00Z');

    expect(page.items.map((item) => item.id)).toEqual([recent]);
  });

  it('presents list items without fiscal internals or storage details', async () => {
    const id = await seed(tenantA, {
      header: {
        issuerRucBase: '80000002',
        issuerRucDv: 1,
        issuerLegalName: 'Proveedor SA',
        establishmentCode: '001',
        expeditionPointCode: '002',
        documentNumber: '0000123',
        issuedAt: new Date('2026-03-10Z'),
        totalAmount: '110000',
        totalVat: '10000',
      },
      artifact: { bytes: XML, name: 'factura.xml' },
    });

    const [item] = (await list()).items;

    expect(item).toMatchObject({
      id,
      status: 'received',
      source: 'sifen_xml',
      version: 1,
      issuer: { ruc: '80000002-1', name: 'Proveedor SA' },
      document_number: '001-002-0000123',
      issued_on: '2026-03-10',
      total_amount: '110000',
      total_vat: '10000',
      has_artifact: true,
    });
    expect(Object.keys(item)).toEqual(
      expect.arrayContaining(['confidence_overall', 'created_at', 'updated_at']),
    );
    expect(JSON.stringify(item)).not.toMatch(/storage|sifen_xml\/|memory:/);
  });

  it('rejects malformed query parameters and ids with 400', async () => {
    for (const query of [
      '?limit=0',
      '?limit=201',
      '?limit=abc',
      '?cursor=garbage',
      '?status=bogus',
      '?source=bogus',
      '?issued_from=yesterday',
      '?updated_since=nope',
      '?is_own_receiver=maybe',
      '?issuer_ruc=abc',
      '?cdc_prefix=12x',
      '?status=confirmed&status=needs_review',
    ]) {
      const response = await get(readA, `/v1/received-documents${query}`);
      expect(response.statusCode, query).toBe(400);
      expect(response.json()).toMatchObject({ statusCode: 400, code: 'invalid_request' });
    }
    for (const suffix of ['', '/artifact', '/artifact-url']) {
      const response = await get(readA, `/v1/received-documents/not-a-uuid${suffix}`);
      expect(response.statusCode, suffix).toBe(400);
    }
  });

  it('returns the detail with items, confidences, review reasons and an artifact link', async () => {
    const id = await seed(tenantA, {
      header: {
        issuerRucBase: '80000002',
        issuerRucDv: 1,
        issuerLegalName: 'Proveedor SA',
        timbrado: '12345678',
        establishmentCode: '001',
        expeditionPointCode: '002',
        documentNumber: '0000123',
        issuedAt: new Date('2026-03-10Z'),
        currency: 'PYG',
        totalAmount: '10000',
        totalVat: '909',
        rawData: { secret: 'raw-parsed-xml' },
      },
      status: 'needs_review',
      isOwnReceiver: false,
      items: true,
      artifact: { bytes: XML, name: 'factura.xml' },
    });

    const response = await get(readA, `/v1/received-documents/${id}`);
    const body = response.json<Record<string, unknown>>();

    expect(response.statusCode).toBe(200);
    expect(body).toMatchObject({
      id,
      status: 'needs_review',
      version: 1,
      is_own_receiver: false,
      needs_review: true,
      needs_review_reasons: ['receiver_mismatch'],
      issuer: { ruc: '80000002-1', legal_name: 'Proveedor SA' },
      timbrado: '12345678',
      document_number: '001-002-0000123',
      issued_on: '2026-03-10',
      currency: 'PYG',
      totals: { total_amount: '10000', total_vat: '909' },
      confirmed_at: null,
      confirmed_by: null,
      artifact_url: `/v1/received-documents/${id}/artifact`,
      artifact: { content_type: 'application/xml', original_name: 'factura.xml' },
      items: [
        {
          position: 1,
          description: 'Servicio',
          quantity: '2',
          unit_price: '5000',
          subtotal: '10000',
          vat_rate: 10,
          vat_amount: '909',
        },
      ],
      field_confidences: [
        {
          field: 'totals',
          confidence: '0.9',
          extracted_value: '10000',
          corrected_value: null,
          corrected_by: null,
          corrected_at: null,
        },
      ],
    });
    expect(response.body).not.toMatch(/raw-parsed-xml|storage_key|sifen_xml\/|memory:/);
  });

  it('streams the stored bytes with their content type and an inline disposition', async () => {
    const id = await seed(tenantA, { artifact: { bytes: XML, name: 'fac"tura.xml' } });

    const response = await get(readA, `/v1/received-documents/${id}/artifact`);

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('application/xml');
    expect(response.headers['content-disposition']).toBe('inline; filename="fac_tura.xml"');
    expect(response.rawPayload.equals(XML)).toBe(true);
  });

  it('returns a short-lived presigned URL for the artifact', async () => {
    const id = await seed(tenantA, { artifact: { bytes: XML, name: null } });

    const response = await get(readA, `/v1/received-documents/${id}/artifact-url`);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      url: `memory://sifen_xml/${tenantA}/${id}.xml?expires=900`,
      expires_in_seconds: 900,
    });
  });

  it('answers 404 not_found for a document without artifact or one that does not exist', async () => {
    const bare = await seed(tenantA);
    for (const url of [
      `/v1/received-documents/${bare}/artifact`,
      `/v1/received-documents/${bare}/artifact-url`,
      `/v1/received-documents/${randomUUID()}`,
      `/v1/received-documents/${randomUUID()}/artifact`,
    ]) {
      const response = await get(readA, url);
      expect(response.statusCode, url).toBe(404);
      expect(response.json()).toMatchObject({ statusCode: 404, code: 'not_found' });
    }
  });

  it('keeps tenants apart: another tenant gets 404 and an empty list', async () => {
    const id = await seed(tenantA, { artifact: { bytes: XML, name: 'a.xml' } });

    expect((await list('', readB)).items).toEqual([]);
    for (const suffix of ['', '/artifact', '/artifact-url']) {
      const response = await get(readB, `/v1/received-documents/${id}${suffix}`);
      expect(response.statusCode, suffix).toBe(404);
    }
  });

  it('requires reception:read: a reception:write key cannot read', async () => {
    const id = await seed(tenantA, { artifact: { bytes: XML, name: 'a.xml' } });
    for (const suffix of ['', `/${id}`, `/${id}/artifact`, `/${id}/artifact-url`]) {
      expect((await get(writeOnlyA, `/v1/received-documents${suffix}`)).statusCode, suffix).toBe(
        403,
      );
    }
  });

  it('answers 503 storage_unavailable on artifact routes when storage is disabled', async () => {
    const id = await seed(tenantA);
    for (const suffix of ['/artifact', '/artifact-url']) {
      const response = await get(readA, `/v1/received-documents/${id}${suffix}`);
      expect(response.statusCode, suffix).toBe(503);
      expect(response.json()).toMatchObject({ code: 'storage_unavailable' });
    }
    expect((await get(readA, `/v1/received-documents/${id}`)).statusCode).toBe(200);
  });
});
