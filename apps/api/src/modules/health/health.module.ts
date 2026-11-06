import { Module } from '@nestjs/common';
import type { HealthCheckPort } from './application/ports/health-check.port.js';
import type { StorageReadinessPort } from './application/ports/storage-readiness.port.js';
import { GetHealthUseCase } from './application/get-health.use-case.js';
import { ProcessHealthCheckAdapter } from './infrastructure/adapters/process-health-check.adapter.js';
import { StorageReadinessAdapter } from './infrastructure/adapters/storage-readiness.adapter.js';
import { HealthController } from './infrastructure/controllers/health.controller.js';
import { createS3StorageProvider } from '../reception/infrastructure/adapters/s3-storage-provider.adapter.js';
import { loadStorageConfig } from '../reception/infrastructure/storage-config.js';
import { HEALTH_CHECK_PORT, STORAGE_READINESS_PORT } from './health.tokens.js';

@Module({
  controllers: [HealthController],
  providers: [
    { provide: HEALTH_CHECK_PORT, useClass: ProcessHealthCheckAdapter },
    {
      // Wiring only: the real S3 provider is built solely when storage is configured.
      provide: STORAGE_READINESS_PORT,
      useFactory: (): StorageReadinessPort => {
        try {
          const storage = loadStorageConfig(process.env, process.env.NODE_ENV);
          return new StorageReadinessAdapter(
            storage.status === 'enabled' ? createS3StorageProvider(storage.config) : null,
          );
        } catch {
          // Invalid/missing config must not crash the API from health: report storage down.
          return new StorageReadinessAdapter({
            ping: () => Promise.reject(new Error('storage misconfigured')),
          });
        }
      },
    },
    {
      provide: GetHealthUseCase,
      useFactory: (port: HealthCheckPort, storage: StorageReadinessPort) =>
        new GetHealthUseCase(port, storage),
      inject: [HEALTH_CHECK_PORT, STORAGE_READINESS_PORT],
    },
  ],
})
export class HealthModule {}
