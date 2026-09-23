import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import { HealthModule } from '../health.module.js';
import { HEALTH_CHECK_PORT } from '../health.tokens.js';
import { ProcessHealthCheckAdapter } from './adapters/process-health-check.adapter.js';

describe('HealthModule', () => {
  it('binds HealthCheckPort to ProcessHealthCheckAdapter', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [HealthModule],
    }).compile();

    const adapter = moduleRef.get<ProcessHealthCheckAdapter>(HEALTH_CHECK_PORT);

    expect(adapter).toBeInstanceOf(ProcessHealthCheckAdapter);
  });
});
