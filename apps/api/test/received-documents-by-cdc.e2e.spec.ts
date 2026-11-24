import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { createPgliteDatabase, tenantFiscalProfiles, type DatabaseHandle } from '@sifen/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { createHttpAdapter } from '../src/bootstrap/http.js';
import { createTenant, issueApiKey } from '../src/cli/commands.js';
import { DATABASE, DATABASE_HANDLE } from '../src/modules/database/database.module.js';
import { computeCdcCheckDigit } from '../src/modules/emission/domain/cdc.js';
import { computeRucCheckDigit } from '../src/modules/fiscal-config/domain/ruc.js';
import { EkuatiaCircuitBreaker } from '../src/modules/reception/application/ekuatia-circuit-breaker.js';
import { EkuatiaSolveQuota } from '../src/modules/reception/application/ekuatia-solve-quota.js';
import { IngestSifenXml } from '../src/modules/reception/application/ingest-sifen-xml.js';
import { LookupCdcDocument } from '../src/modules/reception/application/lookup-cdc-document.js';
import type { EkuatiaLookupJob } from '../src/modules/reception/application/ports/ekuatia-lookup-queue.port.js';
import { ReceptionQueueUnavailableError } from '../src/modules/reception/application/ports/reception-job-queue.port.js';
import { createDrizzleEkuatiaSolveUsageStore } from '../src/modules/reception/infrastructure/adapters/drizzle-ekuatia-solve-usage-store.js';
import { createDrizzleReceivedDocumentRepository } from '../src/modules/reception/infrastructure/adapters/drizzle-received-document-repository.js';
import { createDrizzleTenantFiscalIdentity } from '../src/modules/reception/infrastructure/adapters/drizzle-tenant-fiscal-identity.js';
import { InMemoryStorageProvider } from '../src/modules/reception/infrastructure/adapters/in-memory-storage-provider.js';
import { Libxml2SifenXmlParser } from '../src/modules/reception/infrastructure/adapters/libxml2-sifen-xml-parser.adapter.js';
import {
  EKUATIA_LOOKUP_QUEUE,
  RECEPTION_STORAGE,
} from '../src/modules/reception/reception.tokens.js';
import { createReceptionEkuatiaProcessor } from '../src/worker/reception-ekuatia.processor.js';

const OWN = '80000001';
const FIXTURE = new URL(
  './fixtures/reception/ekuatia/v2026-Q3/success/documento.xml',
  import.meta.url,
);
const FIXTURE_CDC = '00000000000000000000000000000000000000000001';

function cdcWithCode(last: string): string {
  const base = `${'01444444017001001001452822017012515873260988'.slice(0, 42)}${last}`;
  return `${base}${String(computeCdcCheckDigit(base))}`;
}
const CDC_1 = cdcWithCode('1');
const CDC_2 = cdcWithCode('2');
const CDC_3 = cdcWithCode('3');
/** The anonymised capture, re-labelled with a CDC that passes the check digit. */
const xmlFor = (cdc: string) => readFileSync(FIXTURE, 'utf8').replaceAll(FIXTURE_CDC, cdc);

interface Body {
  code?: string;
  reason?: string;
  scope?: string;
  cap?: number;
  cdc?: string;
  status?: string;
  already_queued?: boolean;
  id?: string;
  source?: string;
  items?: { id: string; source: string }[];
}

/**
 * Spec: reception R6.3 over HTTP (PGlite, in-memory storage, a fake queue and fake solver and
 * eKuatia client). Nothing here reaches eKuatia or 2Captcha.
 */
describe('received documents: lookup by CDC (e2e)', () => {
  let handle: DatabaseHandle;
  let app: NestFastifyApplication;
  let tenantA: string;
  let keyA: string;
  let keyReadOnly: string;
  let jobs: EkuatiaLookupJob[];
  let queueDown: boolean;
  let solves: number;
  let storage: InMemoryStorageProvider;
  const kmsKey = randomBytes(32).toString('base64');

  const post = (key: string, body: unknown) =>
    app.inject({
      method: 'POST',
      url: '/v1/received-documents/by-cdc',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      payload: JSON.stringify(body),
    });
  const list = (key: string, cdc: string) =>
    app.inject({
      method: 'GET',
      url: `/v1/received-documents?cdc_prefix=${cdc}`,
      headers: { authorization: `Bearer ${key}` },
    });

  /** Runs the worker side for one queued job with a fake solver and a fake eKuatia client. */
  const runJob = (job: EkuatiaLookupJob, render: (cdc: string) => string = xmlFor) => {
    const repository = createDrizzleReceivedDocumentRepository(handle.db);
    const parser = new Libxml2SifenXmlParser({ maxBytes: 2_000_000 });
    return createReceptionEkuatiaProcessor({
      lookup: new LookupCdcDocument({
        enabled: true,
        repository,
        quota: new EkuatiaSolveQuota({
          store: createDrizzleEkuatiaSolveUsageStore(handle.db),
          tenantCap: 2,
          globalCap: 10,
          now: () => new Date(),
          log: () => undefined,
        }),
        breaker: new EkuatiaCircuitBreaker({
          failureThreshold: 5,
          cooldownMs: 60_000,
          now: () => new Date(),
        }),
        solver: {
          solveRecaptchaV2: () => {
            solves += 1;
            return Promise.resolve('TOKEN');
          },
        },
        client: { consultByCdc: ({ cdc }) => Promise.resolve({ xml: render(cdc) }) },
        parser,
        ingestXml: new IngestSifenXml({
          repository,
          storage,
          parser,
          fiscalIdentity: createDrizzleTenantFiscalIdentity(handle.db),
          now: () => new Date(),
          newId: randomUUID,
        }),
        sitekey: 'sitekey',
        pageUrl: 'https://ekuatia.invalid/consultas/',
      }),
    })({ data: job });
  };

  async function boot(env: Record<string, string>) {
    vi.stubEnv('SIFEN_ENVIRONMENT', 'production');
    vi.stubEnv('KMS_LOCAL_MASTER_KEY', kmsKey);
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
    jobs = [];
    queueDown = false;
    solves = 0;
    storage = new InMemoryStorageProvider();
    handle = createPgliteDatabase();
    await handle.migrate();
    tenantA = (await createTenant(handle.db, 'Acme SA')).id;
    const issue = async (scopes: string[]) =>
      (await issueApiKey(handle.db, { tenantId: tenantA, environment: 'live', scopes }))
        .formattedKey;
    keyA = await issue(['reception:write', 'reception:read']);
    keyReadOnly = await issue(['reception:read']);
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
      .overrideProvider(EKUATIA_LOOKUP_QUEUE)
      .useValue({
        enqueueLookup: (job: EkuatiaLookupJob) => {
          if (queueDown) return Promise.reject(new ReceptionQueueUnavailableError('down'));
          const known = jobs.some((j) => j.tenantId === job.tenantId && j.cdc === job.cdc);
          if (!known) jobs.push(job);
          return Promise.resolve({ enqueued: !known });
        },
        close: () => Promise.resolve(),
      })
      .compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(createHttpAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  }

  const ENABLED = {
    RECEPTION_EKUATIA_ENABLED: 'true',
    TWOCAPTCHA_API_KEY: 'test-key-not-real',
    RECEPTION_EKUATIA_DAILY_SOLVE_CAP: '2',
  };

  afterEach(async () => {
    vi.unstubAllEnvs();
    await app.close();
  });

  describe('enabled', () => {
    beforeEach(async () => {
      await boot(ENABLED);
    });

    it('answers 202 for a bare CDC, queues one lookup and points at the list filter', async () => {
      const response = await post(keyA, { reference: CDC_1 });
      expect(response.statusCode).toBe(202);
      expect(response.json<Body>()).toEqual({
        cdc: CDC_1,
        status: 'queued',
        already_queued: false,
      });
      expect(response.headers.location).toBe(`/v1/received-documents?cdc_prefix=${CDC_1}`);
      expect(jobs).toEqual([
        { tenantId: tenantA, cdc: CDC_1, usageDate: new Date().toISOString().slice(0, 10) },
      ]);
    });

    it('accepts the QR URL of a KuDE', async () => {
      const url = `https://ekuatia.set.gov.py/consultas/qr?nVersion=150&Id=${CDC_1}&dFeEmiDE=abc`;
      const response = await post(keyA, { reference: url });
      expect(response.statusCode).toBe(202);
      expect(response.json<Body>().cdc).toBe(CDC_1);
    });

    it('rejects a bad check digit with 422 before any solve slot is taken', async () => {
      const bad = `${CDC_1.slice(0, 43)}${String((Number(CDC_1[43]) + 1) % 10)}`;
      const response = await post(keyA, { reference: bad });
      expect(response.statusCode).toBe(422);
      expect(response.json<Body>()).toMatchObject({
        code: 'invalid_cdc',
        reason: 'check-digit-mismatch',
      });
      expect(jobs).toHaveLength(0);
      // The two slots of the tenant are still free.
      expect((await post(keyA, { reference: CDC_1 })).statusCode).toBe(202);
      expect((await post(keyA, { reference: CDC_2 })).statusCode).toBe(202);
    });

    it.each([[{}], [{ reference: 5 }], [{ reference: '' }], [null]])(
      'rejects the body %j with 422 invalid_request',
      async (body) => {
        const response = await post(keyA, body);
        expect(response.statusCode).toBe(422);
        expect(response.json<Body>().code).toBe('invalid_request');
      },
    );

    it('refuses over the tenant solve cap with 429 and Retry-After', async () => {
      await post(keyA, { reference: CDC_1 });
      await post(keyA, { reference: CDC_2 });
      const refused = await post(keyA, { reference: CDC_3 });
      expect(refused.statusCode).toBe(429);
      expect(refused.json<Body>()).toMatchObject({
        code: 'ekuatia_quota_exceeded',
        scope: 'tenant',
        cap: 2,
      });
      expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
      expect(jobs).toHaveLength(2);
    });

    it('answers 503 queue_unavailable and gives the slot back', async () => {
      queueDown = true;
      expect((await post(keyA, { reference: CDC_1 })).statusCode).toBe(503);
      expect((await post(keyA, { reference: CDC_2 })).statusCode).toBe(503);
      queueDown = false;
      expect((await post(keyA, { reference: CDC_1 })).statusCode).toBe(202);
      expect((await post(keyA, { reference: CDC_2 })).statusCode).toBe(202);
    });

    it('requires the reception:write scope', async () => {
      expect((await post(keyReadOnly, { reference: CDC_1 })).statusCode).toBe(403);
      expect(jobs).toHaveLength(0);
    });

    it('a worker run ingests the XML as an ekuatia_cdc document, and a repeat dedupes before solving', async () => {
      await post(keyA, { reference: CDC_1 });
      const outcome = await runJob(jobs[0]);
      expect(outcome.outcome).toMatch(/^ingested:(confirmed|needs_review)$/);
      expect(solves).toBe(1);

      const found = (await list(keyA, CDC_1)).json<Body>();
      expect(found.items).toHaveLength(1);
      expect(found.items?.[0]?.source).toBe('ekuatia_cdc');

      const repeat = await post(keyA, { reference: CDC_1 });
      expect(repeat.statusCode).toBe(200);
      expect(repeat.json<Body>()).toMatchObject({
        id: found.items?.[0]?.id,
        source: 'ekuatia_cdc',
      });
      expect(jobs).toHaveLength(1);
      expect(solves).toBe(1);
    });
  });

  describe('requested-CDC guard (real parser)', () => {
    beforeEach(async () => {
      await boot(ENABLED);
    });

    it('accepts a DE Id written with single quotes', async () => {
      await post(keyA, { reference: CDC_1 });
      const outcome = await runJob(jobs[0], (cdc) =>
        xmlFor(cdc).replaceAll(`Id="${cdc}"`, `Id='${cdc}'`),
      );
      expect(outcome.outcome).toMatch(/^ingested:/);
    });

    it('refuses an XML of another document even if another element carries the requested Id', async () => {
      await post(keyA, { reference: CDC_1 });
      const outcome = await runJob(jobs[0], (cdc) =>
        xmlFor(CDC_2).replace('<dVerFor>', `<dVerFor Id="${cdc}">`),
      );
      expect(outcome.outcome).toBe('failed:ekuatia_invalid_response');
      expect((await list(keyA, CDC_1)).json<Body>().items).toHaveLength(0);
    });

    it('refuses an XML whose DE Id is another CDC', async () => {
      await post(keyA, { reference: CDC_1 });
      const outcome = await runJob(jobs[0], () => xmlFor(CDC_3));
      expect(outcome.outcome).toBe('failed:ekuatia_invalid_response');
    });
  });

  describe('disabled', () => {
    it.each([
      ['by default', {}],
      ['when enabled without a solver key', { RECEPTION_EKUATIA_ENABLED: 'true' }],
      ['when the key is set but the switch is off', { TWOCAPTCHA_API_KEY: 'test-key-not-real' }],
    ])('answers 503 ekuatia_unavailable %s and queues nothing', async (_name, env) => {
      await boot(env);
      const response = await post(keyA, { reference: CDC_1 });
      expect(response.statusCode).toBe(503);
      expect(response.json<Body>().code).toBe('ekuatia_unavailable');
      expect(jobs).toHaveLength(0);
    });

    it('answers 503 even for an invalid reference: the switch comes first', async () => {
      await boot({});
      expect((await post(keyA, { reference: 'nope' })).statusCode).toBe(503);
    });
  });
});
