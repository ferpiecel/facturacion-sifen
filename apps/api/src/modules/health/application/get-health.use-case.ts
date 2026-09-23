import type { HealthCheckPort } from './ports/health-check.port.js';
import type { HealthReport } from '../domain/health-report.js';

export class GetHealthUseCase {
  constructor(private readonly healthCheckPort: HealthCheckPort) {}

  async execute(): Promise<HealthReport> {
    const isUp = await this.healthCheckPort.check();

    return {
      status: isUp ? 'up' : 'down',
      uptimeSeconds: process.uptime(),
      checkedAt: new Date().toISOString(),
    };
  }
}
