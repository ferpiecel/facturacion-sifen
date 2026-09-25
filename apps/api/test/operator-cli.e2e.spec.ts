import { Controller, Get, Global, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { ClsModule } from 'nestjs-cls';
import { createPgliteDatabase, type Database, type DatabaseHandle } from '@sifen/db';
import { afterEach, describe, expect, it } from 'vitest';
import { DATABASE } from '../src/modules/database/database.module.js';
import { IdentityModule } from '../src/modules/identity/identity.module.js';
import { createTenant, issueApiKey, revokeApiKey } from '../src/cli/commands.js';

@Controller('probe')
class ProbeController {
  @Get()
  ok(): string {
    return 'ok';
  }
}

/** Boots a real request pipeline (`ApiKeyGuard` included) against `db`, no `DATABASE_URL` needed. */
async function bootApp(db: Database): Promise<NestFastifyApplication> {
  @Global()
  @Module({ providers: [{ provide: DATABASE, useValue: db }], exports: [DATABASE] })
  class TestDatabaseModule {}

  @Module({
    imports: [
      ClsModule.forRoot({ global: true, middleware: { mount: true } }),
      TestDatabaseModule,
      IdentityModule,
    ],
    controllers: [ProbeController],
  })
  class TestAppModule {}

  const app = await NestFactory.create<NestFastifyApplication>(
    TestAppModule,
    new FastifyAdapter(),
    {
      logger: false,
    },
  );
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return app;
}

function injectProbe(app: NestFastifyApplication, bearer: string) {
  return app
    .getHttpAdapter()
    .getInstance()
    .inject({ method: 'GET', url: '/probe', headers: { authorization: `Bearer ${bearer}` } });
}

/**
 * Spec: HU-E1-05. Exercises the operator CLI's own command handlers
 * (`src/cli/commands.ts`) — not a duplicate/parallel implementation — to
 * create a tenant and issue an API key, then proves that key authenticates
 * through the real `ApiKeyGuard`; a revoked key is rejected the same way.
 */
describe('operator-created tenants and api keys (e2e, HU-E1-05)', () => {
  let handle: DatabaseHandle | undefined;
  let app: NestFastifyApplication | undefined;
  const originalEnv = process.env.SIFEN_ENVIRONMENT;

  afterEach(async () => {
    await app?.close();
    await handle?.close();
    app = undefined;
    handle = undefined;
    if (originalEnv === undefined) delete process.env.SIFEN_ENVIRONMENT;
    else process.env.SIFEN_ENVIRONMENT = originalEnv;
  });

  it('a tenant + api key created by the operator authenticates successfully', async () => {
    handle = createPgliteDatabase();
    await handle.migrate();
    const { id: tenantId } = await createTenant(handle.db, 'Operator Tenant');
    const { formattedKey } = await issueApiKey(handle.db, {
      tenantId,
      environment: 'test',
      scopes: ['documents:write'],
    });
    process.env.SIFEN_ENVIRONMENT = 'test';
    app = await bootApp(handle.db);

    expect((await injectProbe(app, formattedKey)).statusCode).toBe(200);
  });

  it('a revoked key is rejected with 401', async () => {
    handle = createPgliteDatabase();
    await handle.migrate();
    const { id: tenantId } = await createTenant(handle.db, 'Operator Tenant');
    const { formattedKey, keyId } = await issueApiKey(handle.db, {
      tenantId,
      environment: 'test',
      scopes: [],
    });
    await revokeApiKey(handle.db, keyId);
    process.env.SIFEN_ENVIRONMENT = 'test';
    app = await bootApp(handle.db);

    expect((await injectProbe(app, formattedKey)).statusCode).toBe(401);
  });
});
