import { randomBytes } from 'node:crypto';
import { type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import {
  auditLog,
  createPgliteDatabase,
  tenantFiscalProfiles,
  type DatabaseHandle,
} from '@sifen/db';
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
import { createReceivedDocument } from '../src/modules/reception/domain/received-document.js';
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
  version: number;
  code?: string;
  extraction_error_code: string | null;
}

/**
 * Spec: reception R5.8. `POST /v1/received-documents/{id}/reprocess` over PGlite: upload, worker
 * run (fake LLM, first disabled, then enabled), reprocess, worker run again.
 */
describe('POST /v1/received-documents/{id}/reprocess (e2e)', () => {
  let handle: DatabaseHandle;
  let app: NestFastifyApplication;
  let tenantA: string;
  let keyA: string;
  let keyB: string;
  let keyReadOnly: string;
  let storage: InMemoryStorageProvider;
  let jobs: ExtractionJob[];
  let queueDown: boolean;
  let uploads: number;
  const kmsKey = randomBytes(32).toString('base64');

  const request = (
    method: 'GET' | 'POST',
    url: string,
    options: { key?: string; payload?: Buffer; type?: string } = {},
  ) =>
    app.inject({
      method,
      url,
      headers: {
        authorization: `Bearer ${options.key ?? keyA}`,
        ...(options.type ? { 'content-type': options.type } : {}),
      },
      payload: options.payload,
    });
  const detail = async (id: string) =>
    (await request('GET', `/v1/received-documents/${id}`)).json<Body>();
  const reprocess = (id: string, key?: string) =>
    request('POST', `/v1/received-documents/${id}/reprocess`, key === undefined ? {} : { key });
  const upload = async () => {
    uploads += 1;
    const response = await request('POST', '/v1/received-documents', {
      payload: Buffer.from(`%PDF-1.7 invoice ${String(uploads)}`),
      type: 'application/pdf',
    });
    return response.json<Body>().id;
  };

  /** Runs the job queued last with an LLM that is either disabled or answers `llmJson()`. */
  async function runWorker(llm: 'disabled' | 'enabled'): Promise<void> {
    const job = jobs.at(-1);
    if (job === undefined) throw new Error('no job queued');
    const fake: ExtractionLlm = {
      extract: () =>
        llm === 'disabled'
          ? Promise.reject(new ExtractionLlmDisabledError())
          : Promise.resolve({
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
    await createReceptionExtractionProcessor({
      extract: new ExtractReceivedDocument({
        repository: createDrizzleReceivedDocumentRepository(handle.db),
        storage,
        pdfRenderer: {
          countPages: () => Promise.resolve(1),
          extractText: () => Promise.resolve('FACTURA'),
          rasterize: () => Promise.resolve([Uint8Array.from([0x89, 0x50, 0x4e, 0x47])]),
        },
        qrDecoder: { decodeCdc: () => Promise.resolve(null) },
        llm: fake,
        fiscalIdentity: createDrizzleTenantFiscalIdentity(handle.db),
        policy: ConfidencePolicy.create(0.85),
        now: () => new Date(),
      }),
    })({ data: job, attemptsMade: 0, opts: { attempts: 3 } });
  }

  beforeEach(async () => {
    vi.stubEnv('SIFEN_ENVIRONMENT', 'production');
    vi.stubEnv('KMS_LOCAL_MASTER_KEY', kmsKey);
    jobs = [];
    uploads = 0;
    queueDown = false;
    storage = new InMemoryStorageProvider();
    handle = createPgliteDatabase();
    await handle.migrate();
    tenantA = (await createTenant(handle.db, 'Acme SA')).id;
    const tenantB = (await createTenant(handle.db, 'Other SA')).id;
    const key = async (tenantId: string, scopes: string[]) =>
      (await issueApiKey(handle.db, { tenantId, environment: 'live', scopes })).formattedKey;
    keyA = await key(tenantA, ['reception:write', 'reception:read']);
    keyB = await key(tenantB, ['reception:write', 'reception:read']);
    keyReadOnly = await key(tenantA, ['reception:read']);
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
          return Promise.resolve();
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

  it('re-queues a document that failed with llm_disabled and extracts it once the LLM is on', async () => {
    const id = await upload();
    await runWorker('disabled');
    const failed = await detail(id);
    expect(failed).toMatchObject({
      status: 'extraction_failed',
      extraction_error_code: 'llm_disabled',
    });

    const response = await reprocess(id);
    expect(response.statusCode).toBe(202);
    expect(response.headers.location).toBe(`/v1/received-documents/${id}`);
    expect(jobs).toHaveLength(2);

    await runWorker('enabled');
    const done = await detail(id);
    expect(done.status).toBe('confirmed');
    expect(done.extraction_error_code).toBeNull();
    // claim extraction_failed -> extracting, then confirmed: one bump each.
    expect(done.version).toBe(failed.version + 2);

    const audits = await handle.db.select().from(auditLog);
    expect(audits.map((a) => a.action)).toContain('received_document.reprocess_requested');
  });

  it('answers 202 twice for a double click and queues a single job', async () => {
    const id = await upload();
    await runWorker('disabled');
    expect((await reprocess(id)).statusCode).toBe(202);
    expect((await reprocess(id)).statusCode).toBe(202);
    expect(jobs).toHaveLength(2); // the upload job plus one reprocess job
  });

  it('answers 409 invalid_state for a confirmed document', async () => {
    const id = await upload();
    await runWorker('enabled');
    const response = await reprocess(id);
    expect(response.statusCode).toBe(409);
    expect(response.json<Body & { status: string }>()).toMatchObject({
      code: 'invalid_state',
      status: 'confirmed',
    });
    expect(jobs).toHaveLength(1);
  });

  it('answers 409 artifact_not_available for a document without a stored artifact', async () => {
    const document = createReceivedDocument({
      id: '33333333-3333-4333-8333-333333333333',
      tenantId: tenantA,
      source: 'pdf',
      isOwnReceiver: true,
    });
    await createDrizzleReceivedDocumentRepository(handle.db).create(tenantA, { document });
    const response = await reprocess(document.id);
    expect(response.statusCode).toBe(409);
    expect(response.json<Body>().code).toBe('artifact_not_available');
  });

  it('answers 404 for another tenant, an unknown id, and 400 for a malformed id', async () => {
    const id = await upload();
    expect((await reprocess(id, keyB)).statusCode).toBe(404);
    expect((await reprocess('33333333-3333-4333-8333-333333333333')).statusCode).toBe(404);
    expect((await reprocess('nope')).statusCode).toBe(400);
  });

  it('needs the reception:write scope', async () => {
    const id = await upload();
    expect((await reprocess(id, keyReadOnly)).statusCode).toBe(403);
  });

  it('answers 503 queue_unavailable and keeps the document reprocessable', async () => {
    const id = await upload();
    await runWorker('disabled');
    queueDown = true;
    const response = await reprocess(id);
    expect(response.statusCode).toBe(503);
    expect(response.json<Body>().code).toBe('queue_unavailable');
    expect((await detail(id)).status).toBe('extraction_failed');
    queueDown = false;
    expect((await reprocess(id)).statusCode).toBe(202);
  });

  it('re-reads an unreadable XML synchronously and reports it when it is still unreadable', async () => {
    const created = await request('POST', '/v1/received-documents', {
      payload: Buffer.from('<rDE><broken'),
      type: 'application/xml',
    });
    expect(created.statusCode).toBe(422);
    const { document_id: documentId } = created.json<{ document_id: string }>();
    const response = await reprocess(documentId);
    expect(response.statusCode).toBe(422);
    expect(response.json<Body>().code).toBe('extraction_failed');
    expect((await detail(documentId)).status).toBe('extraction_failed');
  });
});
