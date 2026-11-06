import { Test } from '@nestjs/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HealthModule } from '../health.module.js';
import type { StorageReadinessPort } from '../application/ports/storage-readiness.port.js';
import { HEALTH_CHECK_PORT, STORAGE_READINESS_PORT } from '../health.tokens.js';
import { ProcessHealthCheckAdapter } from './adapters/process-health-check.adapter.js';

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

  it('reports storage down, without crashing, when production config is missing', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const moduleRef = await Test.createTestingModule({ imports: [HealthModule] }).compile();

    const port = moduleRef.get<StorageReadinessPort>(STORAGE_READINESS_PORT);

    await expect(port.check()).resolves.toBe('down');
  });
});
