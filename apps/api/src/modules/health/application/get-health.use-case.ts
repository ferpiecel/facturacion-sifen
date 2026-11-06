import type { HealthCheckPort } from './ports/health-check.port.js';
import type { StorageReadinessPort } from './ports/storage-readiness.port.js';
import type { HealthReport } from '../domain/health-report.js';

export class GetHealthUseCase {
  constructor(
    private readonly healthCheckPort: HealthCheckPort,
    private readonly storageReadinessPort: StorageReadinessPort,
  ) {}

  async execute(): Promise<HealthReport> {
    const [isUp, storage] = await Promise.all([
      this.healthCheckPort.check(),
      this.storageReadinessPort.check(),
    ]);

    return {
      status: isUp && storage !== 'down' ? 'up' : 'down',
      storage,
      uptimeSeconds: process.uptime(),
      checkedAt: new Date().toISOString(),
    };
  }
}
