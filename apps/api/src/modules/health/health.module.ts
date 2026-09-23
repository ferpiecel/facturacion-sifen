import { Module } from '@nestjs/common';
import type { HealthCheckPort } from './application/ports/health-check.port.js';
import { GetHealthUseCase } from './application/get-health.use-case.js';
import { ProcessHealthCheckAdapter } from './infrastructure/adapters/process-health-check.adapter.js';
import { HealthController } from './infrastructure/controllers/health.controller.js';
import { HEALTH_CHECK_PORT } from './health.tokens.js';

@Module({
  controllers: [HealthController],
  providers: [
    { provide: HEALTH_CHECK_PORT, useClass: ProcessHealthCheckAdapter },
    {
      provide: GetHealthUseCase,
      useFactory: (port: HealthCheckPort) => new GetHealthUseCase(port),
      inject: [HEALTH_CHECK_PORT],
    },
  ],
})
export class HealthModule {}
