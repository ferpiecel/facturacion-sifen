import { type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { createPgliteDatabase, type DatabaseHandle } from '@sifen/db';
import { FakeSifenGateway, SifenTimeoutError, sifenScenarios } from '@sifen/sifen-gateway';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTenant, issueApiKey } from '../src/cli/commands.js';
import { createHttpAdapter } from '../src/bootstrap/http.js';
import { AppModule } from '../src/app.module.js';
import { DATABASE, DATABASE_HANDLE } from '../src/modules/database/database.module.js';
import { RUC_GATEWAY } from '../src/modules/ruc/ruc.tokens.js';

const acme = {
  ruc: '80012345',
  razonSocial: 'ACME SA',
  estado: 'ACT',
  facturadorElectronico: true,
};

/** Spec: HU-E6-09. GET /v1/ruc/:ruc through the cache, against a simulated SIFEN. */
describe('GET /v1/ruc/:ruc (e2e)', () => {
  let handle: DatabaseHandle;
  let app: NestFastifyApplication;
  let gateway: FakeSifenGateway;
  let key: string;
  const originalEnvironment = process.env.SIFEN_ENVIRONMENT;

  const get = (ruc: string, withKey: string | null = key) =>
    app.inject({
      method: 'GET',
      url: `/v1/ruc/${ruc}`,
      headers: withKey ? { authorization: `Bearer ${withKey}` } : {},
    });

  beforeEach(async () => {
    process.env.SIFEN_ENVIRONMENT = 'production';
    handle = createPgliteDatabase();
    await handle.migrate();
    gateway = new FakeSifenGateway();
    const { id } = await createTenant(handle.db, 'Acme SA');
    key = (await issueApiKey(handle.db, { tenantId: id, environment: 'live', scopes: [] }))
      .formattedKey;
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(DATABASE_HANDLE)
      .useValue(handle)
      .overrideProvider(DATABASE)
      .useValue(handle.db)
      .overrideProvider(RUC_GATEWAY)
      .useValue({ gatewayFor: () => gateway, environmentOf: () => Promise.resolve('production') })
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

  it('returns the taxpayer, then serves the repeat from the cache', async () => {
    gateway.enqueue('consultarRUC', sifenScenarios.rucEncontrado(acme));
    const first = await get('80012345');
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({
      ruc: '80012345',
      cached: false,
      taxpayer: { legal_name: 'ACME SA', status: 'ACT', electronic_invoicer: true },
    });
    const second = await get('80012345');
    expect(second.json()).toMatchObject({ cached: true, taxpayer: { legal_name: 'ACME SA' } });
    expect(gateway.callsTo('consultarRUC')).toHaveLength(1);
  });

  it('answers 404 for a RUC SIFEN does not know', async () => {
    expect((await get('80012345')).statusCode).toBe(404);
  });

  it('answers 400 for a malformed RUC', async () => {
    expect((await get('8001234-5')).statusCode).toBe(400);
    expect(gateway.calls).toHaveLength(0);
  });

  it('answers 401 without an API key', async () => {
    expect((await get('80012345', null)).statusCode).toBe(401);
  });

  it('answers 502 when SIFEN refuses the certificate, without leaking details', async () => {
    gateway.enqueue('consultarRUC', sifenScenarios.rucSinPermisoConsulta());
    const response = await get('80012345');
    expect(response.statusCode).toBe(502);
    expect(response.body).not.toContain('0501');
  });

  it('answers 502 on a gateway failure', async () => {
    gateway.enqueue('consultarRUC', new SifenTimeoutError('consultarRUC'));
    expect((await get('80012345')).statusCode).toBe(502);
  });

  it('answers 503 when no SIFEN adapter is available', async () => {
    await app.close();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(DATABASE_HANDLE)
      .useValue(handle)
      .overrideProvider(DATABASE)
      .useValue(handle.db)
      .overrideProvider(RUC_GATEWAY)
      .useValue(null)
      .compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(createHttpAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    expect((await get('80012345')).statusCode).toBe(503);
  });
});
