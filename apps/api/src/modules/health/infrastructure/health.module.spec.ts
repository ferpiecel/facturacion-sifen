import { Test } from '@nestjs/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HealthModule } from '../health.module.js';
import type { StorageReadinessPort } from '../application/ports/storage-readiness.port.js';
import { HEALTH_CHECK_PORT, STORAGE_READINESS_PORT } from '../health.tokens.js';
import { ProcessHealthCheckAdapter } from './adapters/process-health-check.adapter.js';

function unsetStorageEnv(): void {
  for (const name of [
    'STORAGE_ENDPOINT_URL',
    'STORAGE_BUCKET',
    'STORAGE_ACCESS_KEY_ID',
    'STORAGE_SECRET_ACCESS_KEY',
    'STORAGE_REGION',
  ]) {
    vi.stubEnv(name, '');
  }
}

describe('HealthModule', () => {
  it('binds HealthCheckPort to ProcessHealthCheckAdapter', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [HealthModule],
    }).compile();

    const adapter = moduleRef.get<ProcessHealthCheckAdapter>(HEALTH_CHECK_PORT);

    expect(adapter).toBeInstanceOf(ProcessHealthCheckAdapter);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('skips storage when it is not configured in test', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [HealthModule] }).compile();

    const port = moduleRef.get<StorageReadinessPort>(STORAGE_READINESS_PORT);

    await expect(port.check()).resolves.toBe('skipped');
  });

  it('skips storage in production when no STORAGE_* variable is set', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    unsetStorageEnv();
    const moduleRef = await Test.createTestingModule({ imports: [HealthModule] }).compile();

    const port = moduleRef.get<StorageReadinessPort>(STORAGE_READINESS_PORT);

    await expect(port.check()).resolves.toBe('skipped');
  });

  it('skips storage when NODE_ENV is unset and no STORAGE_* variable is set', async () => {
    vi.stubEnv('NODE_ENV', '');
    unsetStorageEnv();
    delete process.env.NODE_ENV;
    const moduleRef = await Test.createTestingModule({ imports: [HealthModule] }).compile();

    const port = moduleRef.get<StorageReadinessPort>(STORAGE_READINESS_PORT);

    await expect(port.check()).resolves.toBe('skipped');
  });

  it('reports storage down, without crashing, when production config is partial', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    unsetStorageEnv();
    vi.stubEnv('STORAGE_BUCKET', 'sifen-artifacts');
    const moduleRef = await Test.createTestingModule({ imports: [HealthModule] }).compile();

    const port = moduleRef.get<StorageReadinessPort>(STORAGE_READINESS_PORT);

    await expect(port.check()).resolves.toBe('down');
  });
});
