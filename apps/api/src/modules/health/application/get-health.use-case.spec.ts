import { describe, expect, it } from 'vitest';
import type { HealthCheckPort } from './ports/health-check.port.js';
import { GetHealthUseCase } from './get-health.use-case.js';

class FakeHealthCheckPort implements HealthCheckPort {
  constructor(private readonly result: boolean) {}

  check(): Promise<boolean> {
    return Promise.resolve(this.result);
  }
}

describe('GetHealthUseCase', () => {
  it('returns status "up" when the port reports healthy', async () => {
    const useCase = new GetHealthUseCase(new FakeHealthCheckPort(true));

    const report = await useCase.execute();

    expect(report.status).toBe('up');
    expect(typeof report.uptimeSeconds).toBe('number');
    expect(typeof report.checkedAt).toBe('string');
  });

  it('returns status "down" when the port reports unhealthy', async () => {
    const useCase = new GetHealthUseCase(new FakeHealthCheckPort(false));

    const report = await useCase.execute();

    expect(report.status).toBe('down');
  });
});
