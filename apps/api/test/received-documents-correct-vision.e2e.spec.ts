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
import { type ExtractionLlm } from '../src/modules/reception/application/ports/extraction-llm.port.js';
import { type ExtractionJob } from '../src/modules/reception/application/ports/reception-job-queue.port.js';
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
const EVENTS = [
  'reception.document.confirmed',
  'reception.document.needs_review',
  'reception.document.updated',
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
  version: number;
  code?: string;
  reasons?: string[];
  needs_review_reasons: string[];
  issuer: { legal_name: string | null };
  totals: { total_amount: string | null };
  corrected_by: string | null;
  field_confidences: {
    field: string;
    confidence: string;
    corrected_value: string | null;
    corrected_by: string | null;
    corrected_at: string | null;
  }[];
}

/**
 * Spec: reception R5.7. Field-level corrections of a document that came from extraction: upload,
 * worker run (fake LLM), then `PATCH /v1/received-documents/{id}` over PGlite.
 */
describe('PATCH /v1/received-documents/{id} on extracted documents (e2e)', () => {
  let handle: DatabaseHandle;
  let app: NestFastifyApplication;
  let tenantA: string;
  let keyA: string;
  let storage: InMemoryStorageProvider;
  let jobs: ExtractionJob[];
  let llmText: string;
  let uploads: number;
  const kmsKey = randomBytes(32).toString('base64');

  const request = (
    method: 'GET' | 'POST' | 'PATCH',
    url: string,
    payload?: Buffer,
    type?: string,
  ) =>
    app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${keyA}`, ...(type ? { 'content-type': type } : {}) },
      payload,
    });
  const detail = async (id: string) =>
    (await request('GET', `/v1/received-documents/${id}`)).json<Body>();
  const patch = (id: string, payload: unknown) =>
    request(
      'PATCH',
      `/v1/received-documents/${id}`,
      Buffer.from(JSON.stringify(payload)),
      'application/json',
    );
  const outboxTypes = async () =>
    (
      await handle.db
        .select()
        .from(webhookDeliveries)
        .where(eq(webhookDeliveries.tenantId, tenantA))
    )
      .map((row) => row.eventType)
      .sort();

  /** Uploads a distinct PDF and runs its extraction job with the current fake LLM answer. */
  async function extract(): Promise<Body> {
    uploads += 1;
    const bytes = Buffer.from(`%PDF-1.7 invoice ${String(uploads)}`);
    const { id } = (
      await request('POST', '/v1/received-documents', bytes, 'application/pdf')
    ).json<Body>();
    const job = jobs.at(-1);
    if (job === undefined) throw new Error('no job queued');
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
        llm: {
          extract: () =>
            Promise.resolve({
              rawText: llmText,
              modelId: 'm',
              usage: {
                inputTokens: 1,
                outputTokens: 1,
                cacheReadInputTokens: 0,
                cacheCreationInputTokens: 0,
              },
            }),
        } satisfies ExtractionLlm,
        fiscalIdentity: createDrizzleTenantFiscalIdentity(handle.db),
        policy: ConfidencePolicy.create(0.85),
        now: () => new Date(),
      }),
    })({ data: job, attemptsMade: 0, opts: { attempts: 3 } });
    return detail(id);
  }

  beforeEach(async () => {
    vi.stubEnv('SIFEN_ENVIRONMENT', 'production');
    vi.stubEnv('KMS_LOCAL_MASTER_KEY', kmsKey);
    jobs = [];
    uploads = 0;
    llmText = llmJson({ overallConfidence: 0.4, fieldConfidences: confidence(0.4) });
    storage = new InMemoryStorageProvider();
    handle = createPgliteDatabase();
    await handle.migrate();
    tenantA = (await createTenant(handle.db, 'Acme SA')).id;
    keyA = (
      await issueApiKey(handle.db, {
        tenantId: tenantA,
        environment: 'live',
        scopes: ['reception:write', 'reception:read', 'webhooks:write'],
      })
    ).formattedKey;
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
          jobs.push(job);
          return Promise.resolve();
        },
        close: () => Promise.resolve(),
      })
      .compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(createHttpAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    await request(
      'POST',
      '/v1/webhooks/endpoints',
      Buffer.from(JSON.stringify({ url: 'https://erp.example.com/hooks', events: EVENTS })),
      'application/json',
    );
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await app.close();
  });

  it('records a corrected low-confidence field with who and when, in the same write as the data', async () => {
    const before = await extract();
    expect(before.status).toBe('needs_review');
    expect(before.needs_review_reasons).toContain('low_confidence');

    const response = await patch(before.id, {
      version: before.version,
      issuer: { legal_name: 'Proveedor SRL' },
    });
    expect(response.statusCode).toBe(200);
    const after = response.json<Body>();
    expect(after.issuer.legal_name).toBe('Proveedor SRL');
    expect(after.version).toBe(before.version + 1);
    expect(after.corrected_by).not.toBeNull();
    const row = after.field_confidences.find((c) => c.field === 'issuer_legal_name');
    expect(row).toMatchObject({ confidence: '0.4', corrected_value: 'Proveedor SRL' });
    expect(row?.corrected_by).toBe(after.corrected_by);
    expect(row?.corrected_at).not.toBeNull();
    // Seven other low fields remain, so the document-level reason stays.
    expect(after.needs_review_reasons).toEqual(['low_confidence']);
  });

  it('clears low_confidence when every low field is corrected or reviewed, then confirms', async () => {
    const before = await extract();
    const reviewed = await patch(before.id, {
      version: before.version,
      issuer: { legal_name: 'Proveedor SRL' },
      reviewed_fields: RECEIVED_FIELD_NAMES.filter((name) => name !== 'issuer_legal_name'),
    });
    expect(reviewed.statusCode).toBe(200);
    expect(reviewed.json<Body>().needs_review_reasons).toEqual(['awaiting_confirmation']);

    const confirmed = await patch(before.id, { version: before.version + 1, confirm: true });
    expect(confirmed.json<Body>().status).toBe('confirmed');
    expect(await outboxTypes()).toEqual([
      'reception.document.confirmed',
      'reception.document.needs_review',
    ]);
  });

  it('rejects a reviewed field outside the 8 with 422 and keeps the document as it was', async () => {
    const before = await extract();
    const response = await patch(before.id, { version: before.version, reviewed_fields: ['cdc'] });
    expect(response.statusCode).toBe(422);
    expect(response.json<Body>().code).toBe('invalid_correction');
    expect((await detail(before.id)).version).toBe(before.version);
  });

  it('blocks the confirm while validations fail and saves nothing', async () => {
    const before = await extract();
    const response = await patch(before.id, {
      version: before.version,
      confirm: true,
      totals: { total_amount: '5' },
      reviewed_fields: ['totals'],
    });
    expect(response.statusCode).toBe(422);
    expect(response.json<Body>()).toMatchObject({ code: 'validation_failed' });
    expect(response.json<Body>().reasons).toContain('totals_blocks_sum_mismatch');
    const after = await detail(before.id);
    expect(after.version).toBe(before.version);
    expect(after.totals.total_amount).toBe('110000');
    expect(after.field_confidences.every((c) => c.corrected_at === null)).toBe(true);
  });

  it('answers 409 with the current version on a stale version', async () => {
    const before = await extract();
    const response = await patch(before.id, { version: before.version + 5, confirm: true });
    expect(response.statusCode).toBe(409);
    expect(response.json<Body>().code).toBe('version_conflict');
  });

  it('revalidates an edited confirmed document atomically and emits updated only then', async () => {
    llmText = llmJson();
    const before = await extract();
    expect(before.status).toBe('confirmed');

    const bad = await patch(before.id, { version: before.version, totals: { total_amount: '5' } });
    expect(bad.statusCode).toBe(422);
    expect((await detail(before.id)).version).toBe(before.version);

    const ok = await patch(before.id, {
      version: before.version,
      issuer: { legal_name: 'Proveedor SRL' },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json<Body>().status).toBe('confirmed');
    expect(await outboxTypes()).toEqual([
      'reception.document.confirmed',
      'reception.document.updated',
    ]);
  });

  it('emits nothing for a document whose receiver is not the tenant', async () => {
    llmText = llmJson({
      receiverRuc: `80000009-${String(computeRucCheckDigit('80000009'))}`,
      overallConfidence: 0.4,
      fieldConfidences: confidence(0.4),
    });
    const before = await extract();
    const confirmed = await patch(before.id, { version: before.version, confirm: true });
    expect(confirmed.json<Body>().status).toBe('confirmed');
    expect(await outboxTypes()).toEqual([]);
  });
});
