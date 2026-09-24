import { Controller, Get, Module, UseGuards } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { createPgliteDatabase, tenants, type DatabaseHandle } from '@sifen/db';
import { ClsModule } from 'nestjs-cls';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TestTenantHeaderGuard } from './guards/test-tenant-header.guard.js';
import { TenancyModule } from '../tenancy.module.js';
import { TenantTransactionRunner } from './tenant-transaction-runner.js';

@Controller('probe')
@UseGuards(TestTenantHeaderGuard)
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

function required<T>(value: T | undefined, message: string): T {
  if (value === undefined) {
    throw new Error(message);
  }
  return value;
}

function createProbeModule(database: DatabaseHandle) {
  @Module({
    imports: [TenancyModule.register({ database })],
    controllers: [ProbeController],
  })
  class ProbeModule {}
  return ProbeModule;
}

/**
 * spec: db-access, "API guard requires tenant header" — proves the guard
 * propagates the tenant id via CLS into a real `withTenantTransaction`
 * call, and that a missing header never reaches it.
 */
describe('TenancyModule integration', () => {
  let handle: DatabaseHandle | undefined;
  let app: NestFastifyApplication | undefined;
  const originalFlag = process.env.ENABLE_TEST_TENANT_HEADER;

  beforeEach(() => {
    process.env.ENABLE_TEST_TENANT_HEADER = 'true';
  });

  afterEach(async () => {
    await app?.close();
    await handle?.close();
    handle = undefined;
    app = undefined;
    if (originalFlag === undefined) {
      delete process.env.ENABLE_TEST_TENANT_HEADER;
    } else {
      process.env.ENABLE_TEST_TENANT_HEADER = originalFlag;
    }
  });

  async function bootstrap(database: DatabaseHandle): Promise<NestFastifyApplication> {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ClsModule.forRoot({ global: true, middleware: { mount: true } }),
        createProbeModule(database),
      ],
    }).compile();

    const nestApp = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await nestApp.init();
    await nestApp.getHttpAdapter().getInstance().ready();
    return nestApp;
  }

  it('propagates the tenant header via CLS into withTenantTransaction', async () => {
    handle = createPgliteDatabase();
    await handle.migrate();
    const inserted = await handle.db.insert(tenants).values({ name: 'Acme SA' }).returning();
    const tenant = required(inserted[0], 'tenant was not inserted');
    app = await bootstrap(handle);

    const response = await app.inject({
      method: 'GET',
      url: '/probe',
      headers: { 'x-tenant-id': tenant.id },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ tenantCount: 1 });
  });

  it('rejects a request without the tenant header before reaching the runner', async () => {
    handle = createPgliteDatabase();
    await handle.migrate();
    app = await bootstrap(handle);

    const response = await app.inject({ method: 'GET', url: '/probe' });

    expect(response.statusCode).toBe(401);
  });

  it('isolates concurrent requests for different tenants (spec: tenant-isolation)', async () => {
    handle = createPgliteDatabase();
    await handle.migrate();
    const inserted = await handle.db
      .insert(tenants)
      .values([{ name: 'Tenant A' }, { name: 'Tenant B' }])
      .returning();
    const tenantA = required(inserted[0], 'tenant A was not inserted');
    const tenantB = required(inserted[1], 'tenant B was not inserted');
    app = await bootstrap(handle);

    const [responseA, responseB] = await Promise.all([
      app.inject({
        method: 'GET',
        url: '/probe/tenant-seen',
        headers: { 'x-tenant-id': tenantA.id },
      }),
      app.inject({
        method: 'GET',
        url: '/probe/tenant-seen',
        headers: { 'x-tenant-id': tenantB.id },
      }),
    ]);

    expect(responseA.json()).toEqual({ tenantSeen: tenantA.id });
    expect(responseB.json()).toEqual({ tenantSeen: tenantB.id });
  });
});
