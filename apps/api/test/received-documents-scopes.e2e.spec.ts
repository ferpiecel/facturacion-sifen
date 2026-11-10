import { type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { createPgliteDatabase, type DatabaseHandle } from '@sifen/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { createHttpAdapter } from '../src/bootstrap/http.js';
import { createTenant, issueApiKey } from '../src/cli/commands.js';
import { DATABASE, DATABASE_HANDLE } from '../src/modules/database/database.module.js';

/** Spec: reception R4.1. API key scopes `reception:read|write` guard `/v1/received-documents`. */
describe('/v1/received-documents scopes (e2e)', () => {
  let handle: DatabaseHandle;
  let app: NestFastifyApplication;
  let tenantId: string;
  const originalEnvironment = process.env.SIFEN_ENVIRONMENT;

  const keyWith = async (scopes: string[]) =>
    (await issueApiKey(handle.db, { tenantId, environment: 'live', scopes })).formattedKey;
  const call = (method: 'GET' | 'POST', key: string | null) =>
    app.inject({
      method,
      url: '/v1/received-documents',
      headers: key ? { authorization: `Bearer ${key}` } : {},
    });

  beforeEach(async () => {
    process.env.SIFEN_ENVIRONMENT = 'production';
    handle = createPgliteDatabase();
    await handle.migrate();
    tenantId = (await createTenant(handle.db, 'Acme SA')).id;
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(DATABASE_HANDLE)
      .useValue(handle)
      .overrideProvider(DATABASE)
      .useValue(handle.db)
      .compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(createHttpAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterEach(async () => {
    await app.close();
    if (originalEnvironment === undefined) delete process.env.SIFEN_ENVIRONMENT;
    else process.env.SIFEN_ENVIRONMENT = originalEnvironment;
  });

  it('answers 401 without a valid API key', async () => {
    expect((await call('GET', null)).statusCode).toBe(401);
    expect((await call('POST', null)).statusCode).toBe(401);
    expect((await call('GET', 'sk_live_nope')).statusCode).toBe(401);
  });

  it('answers 403 for keys without the required scope, documents:* included', async () => {
    const emission = await keyWith(['documents:write', 'documents:read']);
    const readOnly = await keyWith(['reception:read']);
    const writeOnly = await keyWith(['reception:write']);

    expect((await call('GET', emission)).statusCode).toBe(403);
    expect((await call('POST', emission)).statusCode).toBe(403);
    expect((await call('POST', readOnly)).statusCode).toBe(403);
    expect((await call('GET', writeOnly)).statusCode).toBe(403);
  });

  it('lets a key with the right scope past the guard', async () => {
    const read = await call('GET', await keyWith(['reception:read']));
    const write = await call('POST', await keyWith(['reception:write']));

    // GET is still the R4.3 placeholder; POST is real (an empty upload is refused, not 401/403/501).
    expect(read.statusCode).toBe(501);
    expect(read.json<{ message: string }>().message).toBe('not_implemented');
    expect([401, 403, 501]).not.toContain(write.statusCode);
  });
});
