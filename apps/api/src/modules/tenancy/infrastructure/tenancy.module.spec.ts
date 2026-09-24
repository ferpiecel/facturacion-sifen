import { hash } from '@node-rs/argon2';
import { Controller, Get, Module } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { apiKeys, createPgliteDatabase, tenants, type DatabaseHandle } from '@sifen/db';
import { ClsModule } from 'nestjs-cls';
import { afterEach, describe, expect, it } from 'vitest';
import { DATABASE, DATABASE_HANDLE, DatabaseModule } from '../../database/database.module.js';
import { IdentityModule } from '../../identity/identity.module.js';
import { TenancyModule } from '../tenancy.module.js';
import { TenantTransactionRunner } from './tenant-transaction-runner.js';

const KEY_ID = 'a'.repeat(24);
const SECRET = 'b'.repeat(32);

function required<T>(value: T | undefined, message: string): T {
  if (value === undefined) {
    throw new Error(message);
  }
  return value;
}

@Controller('probe')
class ProbeController {
  constructor(private readonly runner: TenantTransactionRunner) {}

  @Get()
  async probe() {
    const rows = await this.runner.run((tx) => tx.select().from(tenants));
    return { tenantCount: rows.length };
  }

  /** Yields before querying, so concurrent requests can interleave in the test. */
  @Get('tenant-seen')
  async tenantSeen() {
    return this.runner.run(async (tx) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      const result = (await tx.execute(
        "select current_setting('app.current_tenant', true) as tenant_seen",
      )) as { rows: Array<{ tenant_seen: string }> };
      return { tenantSeen: result.rows[0]?.tenant_seen };
    });
  }
}

function createProbeModule(database: DatabaseHandle) {
  @Module({
    imports: [DatabaseModule, IdentityModule, TenancyModule.register({ database })],
    controllers: [ProbeController],
  })
  class ProbeModule {}
  return ProbeModule;
}

/**
 * spec: db-access, "API guard requires an authenticated tenant" — proves
 * `ApiKeyGuard` (wired through the real `IdentityModule`/`DatabaseModule`)
 * propagates the tenant id resolved from a real api key via CLS into a
 * real `withTenantTransaction` call, and that a missing/invalid key never
 * reaches the runner.
 */
describe('TenancyModule integration', () => {
  let handle: DatabaseHandle | undefined;
  let app: NestFastifyApplication | undefined;
  const originalEnvironment = process.env.SIFEN_ENVIRONMENT;

  afterEach(async () => {
    await app?.close();
    await handle?.close();
    handle = undefined;
    app = undefined;
    if (originalEnvironment === undefined) {
      delete process.env.SIFEN_ENVIRONMENT;
    } else {
      process.env.SIFEN_ENVIRONMENT = originalEnvironment;
    }
  });

  async function seedTenantWithKey(name: string, keyId: string, secret: string) {
    const db = required(handle, 'handle not set').db;
    const inserted = await db.insert(tenants).values({ name }).returning();
    const tenant = required(inserted[0], 'tenant was not inserted');
    const secretHash = await hash(secret);
    await db.insert(apiKeys).values({
      tenantId: tenant.id,
      keyId,
      environment: 'live',
      secretHash,
      scopes: [],
    });
    return tenant;
  }

  async function bootstrap(database: DatabaseHandle): Promise<NestFastifyApplication> {
    process.env.SIFEN_ENVIRONMENT = 'production';
    const moduleRef = await Test.createTestingModule({
      imports: [
        ClsModule.forRoot({ global: true, middleware: { mount: true } }),
        createProbeModule(database),
      ],
    })
      .overrideProvider(DATABASE_HANDLE)
      .useValue(database)
      .overrideProvider(DATABASE)
      .useValue(database.db)
      .compile();

    const nestApp = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await nestApp.init();
    await nestApp.getHttpAdapter().getInstance().ready();
    return nestApp;
  }

  it('propagates the tenant resolved from a real api key via CLS into withTenantTransaction', async () => {
    handle = createPgliteDatabase();
    await handle.migrate();
    await seedTenantWithKey('Acme SA', KEY_ID, SECRET);
    app = await bootstrap(handle);

    const response = await app.inject({
      method: 'GET',
      url: '/probe',
      headers: { authorization: `Bearer sk_live_${KEY_ID}_${SECRET}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ tenantCount: 1 });
  });

  it('rejects a request without an Authorization header before reaching the runner', async () => {
    handle = createPgliteDatabase();
    await handle.migrate();
    app = await bootstrap(handle);

    const response = await app.inject({ method: 'GET', url: '/probe' });

    expect(response.statusCode).toBe(401);
  });

  it('isolates concurrent requests for different tenants (spec: tenant-isolation)', async () => {
    handle = createPgliteDatabase();
    await handle.migrate();
    const keyIdA = 'a'.repeat(24);
    const keyIdB = 'c'.repeat(24);
    const tenantA = await seedTenantWithKey('Tenant A', keyIdA, SECRET);
    const tenantB = await seedTenantWithKey('Tenant B', keyIdB, SECRET);
    app = await bootstrap(handle);

    const [responseA, responseB] = await Promise.all([
      app.inject({
        method: 'GET',
        url: '/probe/tenant-seen',
        headers: { authorization: `Bearer sk_live_${keyIdA}_${SECRET}` },
      }),
      app.inject({
        method: 'GET',
        url: '/probe/tenant-seen',
        headers: { authorization: `Bearer sk_live_${keyIdB}_${SECRET}` },
      }),
    ]);

    expect(responseA.json()).toEqual({ tenantSeen: tenantA.id });
    expect(responseB.json()).toEqual({ tenantSeen: tenantB.id });
  });
});
