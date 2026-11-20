import { randomBytes } from 'node:crypto';
import { type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import {
  createPgliteDatabase,
  tenantFiscalProfiles,
  webhookDeliveries,
  type DatabaseHandle,
} from '@sifen/db';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { createHttpAdapter } from '../src/bootstrap/http.js';
import { createTenant, issueApiKey } from '../src/cli/commands.js';
import { DATABASE, DATABASE_HANDLE } from '../src/modules/database/database.module.js';
import { computeRucCheckDigit } from '../src/modules/fiscal-config/domain/ruc.js';
import { ExtractReceivedDocument } from '../src/modules/reception/application/extract-received-document.js';
import {
  ExtractionLlmDisabledError,
  type ExtractionLlm,
} from '../src/modules/reception/application/ports/extraction-llm.port.js';
import {
  ReceptionQueueUnavailableError,
  type ExtractionJob,
} from '../src/modules/reception/application/ports/reception-job-queue.port.js';
import {
  ConfidencePolicy,
  RECEIVED_FIELD_NAMES,
} from '../src/modules/reception/domain/confidence-policy.js';
import { createDrizzleReceivedDocumentRepository } from '../src/modules/reception/infrastructure/adapters/drizzle-received-document-repository.js';
import { createDrizzleTenantFiscalIdentity } from '../src/modules/reception/infrastructure/adapters/drizzle-tenant-fiscal-identity.js';
import { InMemoryStorageProvider } from '../src/modules/reception/infrastructure/adapters/in-memory-storage-provider.js';
import {
  RECEPTION_JOB_QUEUE,
  RECEPTION_STORAGE,
} from '../src/modules/reception/reception.tokens.js';
import { createReceptionExtractionProcessor } from '../src/worker/reception-extraction.processor.js';

const OWN = '80000001';
const ISSUER = '80000000';
const PDF = Buffer.from('%PDF-1.7 fake invoice');
const PDF_2 = Buffer.from('%PDF-1.7 another invoice');
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('photo'),
]);
const EVENTS = [
  'reception.document.confirmed',
  'reception.document.needs_review',
  'reception.document.extraction_failed',
];

const confidence = (value: number) =>
  Object.fromEntries(RECEIVED_FIELD_NAMES.map((name) => [name, value]));
const llmJson = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    cdc: null,
    issuerRuc: `${ISSUER}-${String(computeRucCheckDigit(ISSUER))}`,
    issuerLegalName: 'Proveedor SA',
    documentNumber: '001-002-0000123',
    issueDate: '2026-11-06',
    receiverRuc: `${OWN}-${String(computeRucCheckDigit(OWN))}`,
    paymentCondition: 'cash',
    totals: {
      exempt: '0',
      exonerated: '0',
      taxable5: '0',
      taxable10: '100000',
      vat5: '0',
      vat10: '10000',
      total: '110000',
    },
    items: [
      {
        description: 'Servicio',
        productCode: null,
        quantity: '1',
        unitOfMeasure: null,
        unitPrice: '110000',
        discount: null,
        subtotal: '110000',
        vatRate: 10,
        taxableBase: '100000',
        vatAmount: '10000',
      },
    ],
    fieldConfidences: confidence(0.95),
    overallConfidence: 0.95,
    notes: '',
    ...over,
  });

interface Body {
  id: string;
  status: string;
  code?: string;
  document_id?: string;
  extraction_error_code: string | null;
  needs_review_reasons: string[];
  issuer: { legal_name: string | null };
  items: { subtotal: string }[];
  field_confidences: { field_name: string }[];
}

/**
 * Spec: reception R5.6. PDF and photo uploads over HTTP (PGlite, in-memory storage, a fake queue),
 * then the worker processor run by hand with fake LLM, PDF and QR adapters.
 */
describe('received documents: PDF and photo upload (e2e)', () => {
  let handle: DatabaseHandle;
  let app: NestFastifyApplication;
  let tenantA: string;
  let tenantB: string;
  let keyA: string;
  let keyB: string;
  let readOnlyA: string;
  let storage: InMemoryStorageProvider;
  let jobs: ExtractionJob[];
  let queueDown: boolean;
  let llm: ExtractionLlm;
  const kmsKey = randomBytes(32).toString('base64');

  const call = (
    method: 'GET' | 'POST',
    url: string,
    key: string,
    payload?: Buffer,
    type?: string,
  ) =>
    app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${key}`, ...(type ? { 'content-type': type } : {}) },
      payload,
    });
  const upload = (key: string, bytes: Buffer, type = 'application/pdf') =>
    call('POST', '/v1/received-documents', key, bytes, type);
  const detail = async (key: string, id: string) =>
    (await call('GET', `/v1/received-documents/${id}`, key)).json<Body>();
  const outboxTypes = async (tenantId: string) =>
    (
      await handle.db
        .select()
        .from(webhookDeliveries)
        .where(eq(webhookDeliveries.tenantId, tenantId))
    )
      .map((row) => row.eventType)
      .sort();

  const worker = () =>
    createReceptionExtractionProcessor({
      extract: new ExtractReceivedDocument({
        repository: createDrizzleReceivedDocumentRepository(handle.db),
        storage,
        pdfRenderer: {
          countPages: () => Promise.resolve(1),
          extractText: () => Promise.resolve('FACTURA'),
          rasterize: () => Promise.resolve([Uint8Array.from([0x89, 0x50, 0x4e, 0x47])]),
        },
        qrDecoder: { decodeCdc: () => Promise.resolve(null) },
        llm,
        fiscalIdentity: createDrizzleTenantFiscalIdentity(handle.db),
        policy: ConfidencePolicy.create(0.85),
        now: () => new Date(),
      }),
    });
  const runJob = (job: ExtractionJob, attemptsMade = 0) =>
    worker()({ data: job, attemptsMade, opts: { attempts: 3 } });

  beforeEach(async () => {
    vi.stubEnv('SIFEN_ENVIRONMENT', 'production');
    vi.stubEnv('KMS_LOCAL_MASTER_KEY', kmsKey);
    jobs = [];
    queueDown = false;
    storage = new InMemoryStorageProvider();
    llm = {
      extract: () =>
        Promise.resolve({
          rawText: llmJson(),
          modelId: 'm',
          usage: {
            inputTokens: 1,
            outputTokens: 1,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
          },
        }),
    };
    handle = createPgliteDatabase();
    await handle.migrate();
    tenantA = (await createTenant(handle.db, 'Acme SA')).id;
    tenantB = (await createTenant(handle.db, 'Beta SA')).id;
    const key = (tenantId: string, scopes: string[]) =>
      issueApiKey(handle.db, { tenantId, environment: 'live', scopes });
    const all = ['reception:write', 'reception:read', 'webhooks:write'];
    keyA = (await key(tenantA, all)).formattedKey;
    keyB = (await key(tenantB, all)).formattedKey;
    readOnlyA = (await key(tenantA, ['reception:read'])).formattedKey;
    await handle.db.insert(tenantFiscalProfiles).values([
      {
        tenantId: tenantA,
        rucBase: OWN,
        rucDv: computeRucCheckDigit(OWN),
        legalName: 'Empresa SA',
        taxpayerType: 'persona_juridica',
      },
      {
        tenantId: tenantB,
        rucBase: '80000002',
        rucDv: computeRucCheckDigit('80000002'),
        legalName: 'Otra SA',
        taxpayerType: 'persona_juridica',
      },
    ] as (typeof tenantFiscalProfiles.$inferInsert)[]);
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(DATABASE_HANDLE)
      .useValue(handle)
      .overrideProvider(DATABASE)
      .useValue(handle.db)
      .overrideProvider(RECEPTION_STORAGE)
      .useValue(storage)
      .overrideProvider(RECEPTION_JOB_QUEUE)
      .useValue({
        enqueueExtraction: (job: ExtractionJob) => {
          if (queueDown) return Promise.reject(new ReceptionQueueUnavailableError('down'));
          jobs.push(job);
          return Promise.resolve({ enqueued: true });
        },
        close: () => Promise.resolve(),
      })
      .compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(createHttpAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    const endpoint = JSON.stringify({ url: 'https://erp.example.com/hooks', events: EVENTS });
    for (const k of [keyA, keyB]) {
      await call('POST', '/v1/webhooks/endpoints', k, Buffer.from(endpoint), 'application/json');
    }
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await app.close();
  });

  it('accepts a PDF with 202, queues one job, and the worker confirms it', async () => {
    const response = await upload(keyA, PDF);
    expect(response.statusCode).toBe(202);
    const { id, status } = response.json<Body>();
    expect(status).toBe('received');
    expect(response.headers.location).toBe(`/v1/received-documents/${id}`);
    expect(jobs).toEqual([{ tenantId: tenantA, documentId: id }]);

    await expect(runJob(jobs[0])).resolves.toEqual({ outcome: 'extracted:confirmed' });
    const after = await detail(keyA, id);
    expect(after.status).toBe('confirmed');
    expect(after.issuer.legal_name).toBe('Proveedor SA');
    expect(after.items.map((i) => i.subtotal)).toEqual(['110000']);
    expect(after.field_confidences).toHaveLength(8);
    expect(await outboxTypes(tenantA)).toEqual(['reception.document.confirmed']);
  });

  it('accepts a PNG photo the same way', async () => {
    const response = await upload(keyA, PNG, 'image/png');
    expect(response.statusCode).toBe(202);
    expect(jobs).toHaveLength(1);
  });

  it('routes a low-confidence extraction to needs_review with its event', async () => {
    llm = {
      extract: () =>
        Promise.resolve({
          rawText: llmJson({ overallConfidence: 0.4, fieldConfidences: confidence(0.4) }),
          modelId: 'm',
          usage: {
            inputTokens: 1,
            outputTokens: 1,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
          },
        }),
    };
    const { id } = (await upload(keyA, PDF)).json<Body>();
    await runJob(jobs[0]);
    const after = await detail(keyA, id);
    expect(after.status).toBe('needs_review');
    expect(after.needs_review_reasons).toContain('low_confidence');
    expect(await outboxTypes(tenantA)).toEqual(['reception.document.needs_review']);
  });

  it('answers 200 for the same bytes and queues nothing new', async () => {
    const first = (await upload(keyA, PDF)).json<Body>();
    await runJob(jobs[0]);
    const second = await upload(keyA, PDF);
    expect(second.statusCode).toBe(200);
    expect(second.json<Body>().id).toBe(first.id);
    expect(jobs).toHaveLength(1);
  });

  it('answers 503 queue_unavailable, keeps the upload and recovers on a repeat', async () => {
    queueDown = true;
    const down = await upload(keyA, PDF_2);
    expect(down.statusCode).toBe(503);
    const { code, document_id: id } = down.json<Body>();
    expect(code).toBe('queue_unavailable');
    expect((await detail(keyA, id ?? '')).status).toBe('received');
    queueDown = false;
    const retry = await upload(keyA, PDF_2);
    expect(retry.statusCode).toBe(200);
    expect(retry.json<Body>().id).toBe(id);
    expect(jobs).toEqual([{ tenantId: tenantA, documentId: id }]);
  });

  it('hides a document from another tenant', async () => {
    const { id } = (await upload(keyA, PDF)).json<Body>();
    expect((await call('GET', `/v1/received-documents/${id}`, keyB)).statusCode).toBe(404);
  });

  it('requires the reception:write scope', async () => {
    expect((await upload(readOnlyA, PDF)).statusCode).toBe(403);
    expect(jobs).toHaveLength(0);
  });

  it('rejects bytes that are neither XML, PDF nor an image', async () => {
    const response = await upload(keyA, Buffer.from('plain text'), 'application/octet-stream');
    expect(response.statusCode).toBe(415);
    expect(response.json<Body>().code).toBe('unsupported_media_type');
  });

  it('ends in extraction_failed with llm_disabled when the LLM is off, and tells the ERP', async () => {
    llm = { extract: () => Promise.reject(new ExtractionLlmDisabledError()) };
    const { id } = (await upload(keyA, PDF)).json<Body>();
    await expect(runJob(jobs[0])).resolves.toEqual({ outcome: 'failed:llm_disabled' });
    const after = await detail(keyA, id);
    expect(after.status).toBe('extraction_failed');
    expect(after.extraction_error_code).toBe('llm_disabled');
    expect(await outboxTypes(tenantA)).toEqual(['reception.document.extraction_failed']);
  });
});
