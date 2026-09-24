import { Controller, Get, Module, UseGuards } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { createPgliteDatabase, tenants, type DatabaseHandle } from '@sifen/db';
import { ClsModule } from 'nestjs-cls';
import { afterEach, describe, expect, it } from 'vitest';
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
}

@Module({ controllers: [ProbeController] })
class ProbeModule {}

/**
 * spec: db-access, "API guard requires tenant header" — proves the guard
 * propagates the tenant id via CLS into a real `withTenantTransaction`
 * call, and that a missing header never reaches it.
 */
describe('TenancyModule integration', () => {
  let handle: DatabaseHandle | undefined;
  let app: NestFastifyApplication | undefined;

  afterEach(async () => {
    await app?.close();
    await handle?.close();
    handle = undefined;
    app = undefined;
  });

  async function bootstrap(database: DatabaseHandle): Promise<NestFastifyApplication> {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ClsModule.forRoot({ global: true, middleware: { mount: true } }),
        TenancyModule.register({ database }),
        ProbeModule,
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
    const [tenant] = await handle.db.insert(tenants).values({ name: 'Acme SA' }).returning();
    app = await bootstrap(handle);

    const response = await app.inject({
      method: 'GET',
      url: '/probe',
      headers: { 'x-tenant-id': tenant!.id },
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
});
