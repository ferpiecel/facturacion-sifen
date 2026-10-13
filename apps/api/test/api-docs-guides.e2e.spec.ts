import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppModule } from '../src/app.module.js';

async function boot(env: { NODE_ENV: string; guidesDir?: string }) {
  vi.stubEnv('NODE_ENV', env.NODE_ENV);
  vi.stubEnv('API_DOCS_ENABLED', '');
  vi.stubEnv('API_DOCS_GUIDES_DIR', env.guidesDir ?? '');
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

describe('GET /docs/guides (e2e)', () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await close?.();
    close = undefined;
    vi.unstubAllEnvs();
  });

  it('lists the repository guides grouped by folder, titled by their first heading', async () => {
    const { app, get } = await boot({ NODE_ENV: 'development' });
    close = () => app.close();

    const res = await get('/docs/guides');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.payload).toContain('href="/docs/guides/adr/0001-registrar-decisiones-con-adr.md"');
    expect(res.payload).toContain('href="/docs/guides/prd/prd.md"');
    expect(res.payload).toContain('href="/docs"');
    expect(res.payload).toContain('adr');
  });

  it('renders a nested page (an ADR) with a nav back to the index and the API reference', async () => {
    const { app, get } = await boot({ NODE_ENV: 'development' });
    close = () => app.close();

    const res = await get('/docs/guides/adr/0001-registrar-decisiones-con-adr.md');
    expect(res.statusCode).toBe(200);
    expect(res.payload).toContain('<h1');
    expect(res.payload).toContain('href="/docs/guides"');
    expect(res.payload).toContain('href="/docs"');
    expect(res.payload).not.toContain('<script');
  });

  it('sends a CSP without script-src and no inline script', async () => {
    const { app, get } = await boot({ NODE_ENV: 'development' });
    close = () => app.close();

    for (const url of ['/docs/guides', '/docs/guides/roadmap.md']) {
      const csp = String((await get(url)).headers['content-security-policy']);
      expect(csp).toContain("default-src 'none'");
      expect(csp).not.toContain('script-src');
    }
  });

  it.each([
    '/docs/guides/missing.md',
    '/docs/guides/..%2fpackage.json',
    '/docs/guides/..%2f..%2fREADME.md',
    '/docs/guides/%2e%2e/README.md',
    '/docs/guides/%2e%2e%2f%2e%2e%2fREADME.md',
    '/docs/guides/adr/..%2f..%2fCLAUDE.md',
    '/docs/guides/%2Fetc%2Fpasswd',
    '/docs/guides//etc/passwd',
    '/docs/guides/roadmap.pdf',
    '/docs/guides/roadmap.md%00',
  ])('answers 404 for %s', async (url) => {
    const { app, get } = await boot({ NODE_ENV: 'development' });
    close = () => app.close();

    expect((await get(url)).statusCode).toBe(404);
  });

  it('escapes raw HTML written in the Markdown', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'guides-e2e-'));
    mkdirSync(join(dir, 'sub'));
    writeFileSync(join(dir, 'sub', 'xss.md'), '# T\n\n<script>alert(1)</script>\n\n[a](../b.md)');
    writeFileSync(join(dir, 'b.md'), '# B');
    const { app, get } = await boot({ NODE_ENV: 'development', guidesDir: dir });
    close = () => app.close();

    const res = await get('/docs/guides/sub/xss.md');
    expect(res.statusCode).toBe(200);
    expect(res.payload).not.toContain('<script>alert');
    expect(res.payload).toContain('&lt;script&gt;alert(1)');
    expect(res.payload).toContain('href="/docs/guides/b.md"');
  });

  it('serves an empty index when the docs folder is missing', async () => {
    const { app, get } = await boot({
      NODE_ENV: 'development',
      guidesDir: join(tmpdir(), 'no-such-docs-dir'),
    });
    close = () => app.close();

    const res = await get('/docs/guides');
    expect(res.statusCode).toBe(200);
    expect(res.payload).not.toContain('/docs/guides/');
    expect((await get('/docs/guides/prd/prd.md')).statusCode).toBe(404);
  });

  it.each([{ NODE_ENV: 'production' }, { NODE_ENV: '' }, { NODE_ENV: 'staging' }])(
    'answers 404 on the index and the pages when disabled (%o)',
    async (env) => {
      const { app, get } = await boot(env);
      close = () => app.close();

      expect((await get('/docs/guides')).statusCode).toBe(404);
      expect((await get('/docs/guides/prd/prd.md')).statusCode).toBe(404);
    },
  );
});
