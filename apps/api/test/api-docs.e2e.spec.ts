import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { buildOpenApiDocument } from '../src/modules/api-docs/infrastructure/openapi.js';

async function boot(env: { NODE_ENV: string; API_DOCS_ENABLED?: string }) {
  vi.stubEnv('NODE_ENV', env.NODE_ENV);
  vi.stubEnv('API_DOCS_ENABLED', env.API_DOCS_ENABLED ?? '');
  // Production refuses to boot without these; they are irrelevant to the docs routes.
  vi.stubEnv('SIFEN_ENVIRONMENT', 'test');
  vi.stubEnv('KMS_LOCAL_MASTER_KEY', Buffer.alloc(32, 1).toString('base64'));
  vi.stubEnv('AUTH_SUBJECT_PEPPER', 'p'.repeat(48));
  vi.stubEnv('PORTAL_ORIGIN', 'https://app.example.com');
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), {
    logger: false,
    abortOnError: false,
  });
  await app.init();
  const fastify = app.getHttpAdapter().getInstance();
  await fastify.ready();
  return { app, get: (url: string) => fastify.inject({ method: 'GET', url }) };
}

describe('GET /docs (e2e, HU-E5-01)', () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await close?.();
    close = undefined;
    vi.unstubAllEnvs();
  });

  it('serves the Redoc viewer and the generated spec in development, without an API key', async () => {
    const { app, get } = await boot({ NODE_ENV: 'development' });
    close = () => app.close();

    const page = await get('/docs');
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-type']).toContain('text/html');
    expect(page.payload).toContain('<redoc spec-url="/docs/openapi.json"');
    expect(page.payload).toMatch(/integrity="sha384-[A-Za-z0-9+/=]+"/);
    expect(page.headers['content-security-policy']).toContain("default-src 'none'");

    const spec = await get('/docs/openapi.json');
    expect(spec.statusCode).toBe(200);
    expect(spec.headers['content-type']).toContain('application/json');
    expect(JSON.parse(spec.payload)).toEqual(JSON.parse(JSON.stringify(buildOpenApiDocument())));
  });

  it('does not list its own routes in the integrator spec', () => {
    expect(Object.keys(buildOpenApiDocument().paths).filter((p) => p.startsWith('/docs'))).toEqual(
      [],
    );
  });

  it.each([{ NODE_ENV: 'production' }, { NODE_ENV: '' }, { NODE_ENV: 'staging' }])(
    'answers 404 on both routes when disabled (%o)',
    async (env) => {
      const { app, get } = await boot(env);
      close = () => app.close();

      expect((await get('/docs')).statusCode).toBe(404);
      expect((await get('/docs/openapi.json')).statusCode).toBe(404);
    },
  );

  it('is enabled in production by API_DOCS_ENABLED=true', async () => {
    const { app, get } = await boot({ NODE_ENV: 'production', API_DOCS_ENABLED: 'true' });
    close = () => app.close();

    expect((await get('/docs')).statusCode).toBe(200);
    expect((await get('/docs/openapi.json')).statusCode).toBe(200);
  });
});
