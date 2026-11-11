import { type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { createPgliteDatabase, type DatabaseHandle } from '@sifen/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTenant, issueApiKey } from '../src/cli/commands.js';
import { createHttpAdapter } from '../src/bootstrap/http.js';
import { AppModule } from '../src/app.module.js';
import { DATABASE, DATABASE_HANDLE } from '../src/modules/database/database.module.js';

/** Spec: HU-E5-08 / ADR-0017. Geographic read endpoints: API key only, filtered by parent. */
describe('GET /v1/geo (e2e)', () => {
  let handle: DatabaseHandle;
  let app: NestFastifyApplication;
  let key: string;
  const originalEnvironment = process.env.SIFEN_ENVIRONMENT;

  const get = (url: string, withKey: string | null = key) =>
    app.inject({
      method: 'GET',
      url,
      headers: withKey ? { authorization: `Bearer ${withKey}` } : {},
    });

  beforeEach(async () => {
    process.env.SIFEN_ENVIRONMENT = 'production';
    handle = createPgliteDatabase();
    await handle.migrate();
    const { id } = await createTenant(handle.db, 'Acme SA');
    // No scopes at all: a valid key is enough (ADR-0017).
    key = (await issueApiKey(handle.db, { tenantId: id, environment: 'live', scopes: [] }))
      .formattedKey;
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

  it('lists the 18 departments with a key that has no scopes', async () => {
    const response = await get('/v1/geo/departments');

    expect(response.statusCode).toBe(200);
    const { items } = response.json<{ items: { code: number; name: string }[] }>();
    expect(items).toHaveLength(18);
    expect(items[10]).toEqual({ code: 11, name: 'ALTO PARANA' });
  });

  it('lists only the districts of the department, with their parent', async () => {
    const response = await get('/v1/geo/districts?departmentCode=11');

    expect(response.statusCode).toBe(200);
    const { items } = response.json<{ items: { code: number; departmentCode: number }[] }>();
    expect(items.length).toBeGreaterThan(5);
    expect(items.every((d) => d.departmentCode === 11)).toBe(true);
    expect(items).toContainEqual({ code: 145, departmentCode: 11, name: 'CIUDAD DEL ESTE' });
  });

  it('lists only the cities of the district', async () => {
    const response = await get('/v1/geo/cities?districtCode=145');

    expect(response.statusCode).toBe(200);
    const { items } = response.json<{ items: { code: number; districtCode: number }[] }>();
    expect(items.every((c) => c.districtCode === 145)).toBe(true);
    expect(items.map((c) => c.code)).toContain(3432);
  });

  it('answers 400 when the parent is missing, repeated or malformed', async () => {
    for (const url of [
      '/v1/geo/districts',
      '/v1/geo/districts?departmentCode=abc',
      '/v1/geo/cities',
      '/v1/geo/cities?districtCode=1&districtCode=2',
    ]) {
      expect((await get(url)).statusCode, url).toBe(400);
    }
  });

  it('answers 404 for a parent that is not in the table', async () => {
    expect((await get('/v1/geo/districts?departmentCode=99')).statusCode).toBe(404);
    expect((await get('/v1/geo/cities?districtCode=9999')).statusCode).toBe(404);
  });

  it('requires a valid API key', async () => {
    expect((await get('/v1/geo/departments', null)).statusCode).toBe(401);
    expect((await get('/v1/geo/departments', 'sk_live_nope')).statusCode).toBe(401);
  });
});
