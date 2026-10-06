import { performance } from 'node:perf_hooks';
import { type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import {
  createPgliteDatabase,
  tenantEstablishments,
  tenantExpeditionPoints,
  tenantFiscalProfiles,
  tenantTimbrados,
  type DatabaseHandle,
} from '@sifen/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTenant, issueApiKey } from '../src/cli/commands.js';
import { createHttpAdapter } from '../src/bootstrap/http.js';
import { AppModule } from '../src/app.module.js';
import { DATABASE, DATABASE_HANDLE } from '../src/modules/database/database.module.js';

/**
 * RNF-04 latency measurement (HU-E5-01 S4). Opt-in: `BENCH_LATENCY=1 pnpm exec vitest run
 * test/latency.bench.spec.ts` (`BENCH_N` requests per route, default 200). It prints p50/p95/p99
 * and never asserts on absolute timings, which depend on the machine.
 */
const enabled = process.env.BENCH_LATENCY === '1';
const N = Number(process.env.BENCH_N ?? 200);

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
  items: [
    {
      code: 'A-001',
      description: 'Servicio de consultoria',
      unitCode: 77,
      quantity: 1,
      unitPrice: 110_000,
      vatRate: 10,
    },
  ],
  roundingPyg: 0,
  location: { departmentCode: 11 },
};

const percentile = (sorted: number[], p: number) =>
  sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];

function report(label: string, samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b);
  const [p50, p95, p99] = [50, 95, 99].map((p) => percentile(sorted, p).toFixed(1));
  process.stdout.write(
    `${label}: n=${String(sorted.length)} p50=${p50}ms p95=${p95}ms p99=${p99}ms\n`,
  );
}

describe.skipIf(!enabled)('latency (opt-in benchmark)', () => {
  let handle: DatabaseHandle;
  let app: NestFastifyApplication;
  let bearer: string;

  beforeAll(async () => {
    process.env.SIFEN_ENVIRONMENT = 'production';
    handle = createPgliteDatabase();
    await handle.migrate();
    const { id } = await createTenant(handle.db, 'Bench SA');
    bearer = (
      await issueApiKey(handle.db, {
        tenantId: id,
        environment: 'live',
        scopes: ['documents:write', 'documents:read'],
      })
    ).formattedKey;
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
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(DATABASE_HANDLE)
      .useValue(handle)
      .overrideProvider(DATABASE)
      .useValue(handle.db)
      .compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(createHttpAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  }, 120_000);

  afterAll(async () => {
    await app.close();
  });

  it('measures POST /v1/documents and GET /v1/documents/:id', async () => {
    const headers = { authorization: `Bearer ${bearer}` };
    const timed = async (run: () => Promise<{ statusCode: number }>, expected: number) => {
      const start = performance.now();
      const response = await run();
      const elapsed = performance.now() - start;
      expect(response.statusCode).toBe(expected);
      return elapsed;
    };
    const post = (i: number) =>
      app.inject({
        method: 'POST',
        url: '/v1/documents',
        payload: BODY,
        headers: { ...headers, 'idempotency-key': `bench-${String(i)}` },
      });

    for (let i = 0; i < 10; i++) await timed(() => post(-i - 1), 202); // warm-up
    const ids: string[] = [];
    const posts: number[] = [];
    for (let i = 0; i < N; i++) {
      const start = performance.now();
      const response = await post(i);
      posts.push(performance.now() - start);
      expect(response.statusCode).toBe(202);
      ids.push(response.json<{ document_id: string }>().document_id);
    }
    const gets: number[] = [];
    for (const id of ids) {
      gets.push(
        await timed(() => app.inject({ method: 'GET', url: `/v1/documents/${id}`, headers }), 200),
      );
    }
    report('POST /v1/documents (202 accept path, in-process, PGlite)', posts);
    report('GET  /v1/documents/:id', gets);
  }, 300_000);
});
