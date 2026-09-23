import { NestFactory } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { HEALTH_CHECK_PORT } from '../src/modules/health/health.tokens.js';

describe('GET /health (e2e)', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns 200 with an up status', async () => {
    const response = await app.getHttpAdapter().getInstance().inject({
      method: 'GET',
      url: '/health',
    });

    expect(response.statusCode).toBe(200);

    const body = JSON.parse(response.payload) as { status: string };
    expect(body.status).toBe('up');
  });

  it('returns 503 with a down status when the health check fails', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(HEALTH_CHECK_PORT)
      .useValue({ check: () => Promise.resolve(false) })
      .compile();
    const downApp = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await downApp.init();
    await downApp.getHttpAdapter().getInstance().ready();

    const response = await downApp.getHttpAdapter().getInstance().inject({
      method: 'GET',
      url: '/health',
    });
    await downApp.close();

    expect(response.statusCode).toBe(503);

    const body = JSON.parse(response.payload) as { status: string };
    expect(body.status).toBe('down');
  });
});
