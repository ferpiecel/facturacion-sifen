import { randomBytes } from 'node:crypto';
import { type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { createPgliteDatabase, tenantFiscalProfiles, type DatabaseHandle } from '@sifen/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { createHttpAdapter } from '../src/bootstrap/http.js';
import { createTenant, issueApiKey } from '../src/cli/commands.js';
import { DATABASE, DATABASE_HANDLE } from '../src/modules/database/database.module.js';
import { computeRucCheckDigit } from '../src/modules/fiscal-config/domain/ruc.js';
import { ExtractReceivedDocument } from '../src/modules/reception/application/extract-received-document.js';
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
const PDF_3 = Buffer.from('%PDF-1.7 a third invoice');

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
  cap?: number;
  document_id?: string;
}

/**
 * Spec: reception R5.9. The per-tenant daily extraction cap over HTTP (PGlite, in-memory storage,
 * a fake queue): uploads and reprocesses stop with 429 `extraction_quota_exceeded` and
 * `Retry-After`; duplicates and other tenants are untouched.
 */
describe('received documents: extraction quota (e2e)', () => {
  let handle: DatabaseHandle;
  let app: NestFastifyApplication;
  let tenantA: string;
  let keyA: string;
  let keyB: string;
  let storage: InMemoryStorageProvider;
  let jobs: ExtractionJob[];
  let queueDown: boolean;
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
  const upload = (key: string, bytes: Buffer) =>
    call('POST', '/v1/received-documents', key, bytes, 'application/pdf');
  const reprocess = (key: string, id: string) =>
    call('POST', `/v1/received-documents/${id}/reprocess`, key);

  const runJob = (job: ExtractionJob) =>
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
        llm: {
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
        },
        fiscalIdentity: createDrizzleTenantFiscalIdentity(handle.db),
        policy: ConfidencePolicy.create(0.85),
        now: () => new Date(),
      }),
    })({ data: job, attemptsMade: 0, opts: { attempts: 3 } });

  beforeEach(async () => {
    vi.stubEnv('SIFEN_ENVIRONMENT', 'production');
    vi.stubEnv('KMS_LOCAL_MASTER_KEY', kmsKey);
    vi.stubEnv('RECEPTION_EXTRACTION_DAILY_CAP', '2');
    jobs = [];
    queueDown = false;
    storage = new InMemoryStorageProvider();
    handle = createPgliteDatabase();
    await handle.migrate();
    tenantA = (await createTenant(handle.db, 'Acme SA')).id;
    const tenantB = (await createTenant(handle.db, 'Beta SA')).id;
    const key = async (tenantId: string) =>
      (
        await issueApiKey(handle.db, {
          tenantId,
          environment: 'live',
          scopes: ['reception:write', 'reception:read', 'webhooks:write'],
        })
      ).formattedKey;
    keyA = await key(tenantA);
    keyB = await key(tenantB);
    await handle.db.insert(tenantFiscalProfiles).values({
      tenantId: tenantA,
      rucBase: OWN,
      rucDv: computeRucCheckDigit(OWN),
      legalName: 'Empresa SA',
      taxpayerType: 'persona_juridica',
    } as typeof tenantFiscalProfiles.$inferInsert);

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
          const known = jobs.some(
            (j) => j.documentId === job.documentId && j.attempt === job.attempt,
          );
          if (!known) jobs.push(job);
          return Promise.resolve({ enqueued: !known });
        },
        close: () => Promise.resolve(),
      })
      .compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(createHttpAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await app.close();
  });

  it('refuses the upload past the cap with 429, Retry-After and no document', async () => {
    expect((await upload(keyA, PDF)).statusCode).toBe(202);
    expect((await upload(keyA, PDF_2)).statusCode).toBe(202);
    const refused = await upload(keyA, PDF_3);
    expect(refused.statusCode).toBe(429);
    expect(refused.json<Body>()).toMatchObject({ code: 'extraction_quota_exceeded', cap: 2 });
    const retryAfter = Number(refused.headers['retry-after']);
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(86_400);
    expect(jobs).toHaveLength(2);
    const list = (await call('GET', '/v1/received-documents', keyA)).json<{ items: unknown[] }>();
    expect(list.items).toHaveLength(2);
  });

  it('does not count a duplicate upload and keeps other tenants separate', async () => {
    await upload(keyA, PDF);
    await upload(keyA, PDF_2);
    expect((await upload(keyA, PDF)).statusCode).toBe(200);
    expect((await upload(keyA, PDF_3)).statusCode).toBe(429);
    expect((await upload(keyB, PDF_3)).statusCode).toBe(202);
  });

  it('gives the slot back when the queue is down', async () => {
    queueDown = true;
    expect((await upload(keyA, PDF)).statusCode).toBe(503);
    expect((await upload(keyA, PDF_2)).statusCode).toBe(503);
    queueDown = false;
    expect((await upload(keyA, PDF)).statusCode).toBe(200);
    expect((await upload(keyA, PDF_2)).statusCode).toBe(200);
    // Only the two jobs that were actually queued hold a slot.
    expect((await upload(keyA, PDF_3)).statusCode).toBe(429);
    expect(jobs).toHaveLength(2);
  });

  it('counts a reprocess that queues a job and refuses the next one past the cap', async () => {
    const first = (await upload(keyA, PDF)).json<Body>();
    await runJob(jobs[0]);
    expect((await reprocess(keyA, first.id)).statusCode).toBe(202);
    expect(jobs).toHaveLength(2);

    const refused = await upload(keyA, PDF_2);
    expect(refused.statusCode).toBe(429);
    expect(refused.json<Body>().code).toBe('extraction_quota_exceeded');
  });

  it('refuses a reprocess at the cap with 429 and queues nothing', async () => {
    const first = (await upload(keyA, PDF)).json<Body>();
    await upload(keyA, PDF_2);
    await runJob(jobs[0]);
    const refused = await reprocess(keyA, first.id);
    expect(refused.statusCode).toBe(429);
    expect(refused.json<Body>()).toMatchObject({ code: 'extraction_quota_exceeded', cap: 2 });
    expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
    expect(jobs).toHaveLength(2);
  });
});
