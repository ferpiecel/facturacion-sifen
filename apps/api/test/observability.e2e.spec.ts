import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { InMemorySpanExporter, type SpanExporter } from '@opentelemetry/sdk-trace';
import { afterEach, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { createTelemetryRuntime } from '../src/modules/telemetry/infrastructure/telemetry-runtime.js';
import { TELEMETRY_RUNTIME } from '../src/modules/telemetry/telemetry.tokens.js';

const TOKEN = 'a-long-enough-token';

async function start(
  env: NodeJS.ProcessEnv,
  spanExporter?: SpanExporter,
): Promise<NestFastifyApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(TELEMETRY_RUNTIME)
    .useValue(createTelemetryRuntime(env, { spanExporter }))
    .compile();
  const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return app;
}

const get = (app: NestFastifyApplication, url: string, headers: Record<string, string> = {}) =>
  app.getHttpAdapter().getInstance().inject({ method: 'GET', url, headers });

/** Spec: HU-E14-01. /metrics and the request trace id. */
describe('observability (e2e)', () => {
  let app: NestFastifyApplication | undefined;
  afterEach(async () => {
    await app?.close();
  });

  it('is off by default: no /metrics and no trace header', async () => {
    app = await start({});
    expect((await get(app, '/metrics')).statusCode).toBe(404);
    expect((await get(app, '/health')).headers['x-trace-id']).toBeUndefined();
  });

  it('serves Prometheus text only with the bearer token', async () => {
    app = await start({ METRICS_ENABLED: 'true', METRICS_TOKEN: TOKEN });
    expect((await get(app, '/metrics')).statusCode).toBe(401);
    expect((await get(app, '/metrics', { authorization: 'Bearer wrong' })).statusCode).toBe(401);
    const ok = await get(app, '/metrics', { authorization: `Bearer ${TOKEN}` });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['content-type']).toContain('text/plain');
  });

  it('echoes the request trace id when tracing is on', async () => {
    app = await start(
      { OTEL_ENABLED: 'true', OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:1' },
      new InMemorySpanExporter(),
    );
    const response = await get(app, '/health');
    expect(response.statusCode).toBe(200);
    expect(response.headers['x-trace-id']).toMatch(/^[0-9a-f]{32}$/);
  });
});
