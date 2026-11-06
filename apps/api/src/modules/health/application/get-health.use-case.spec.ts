import { describe, expect, it } from 'vitest';
import type { HealthCheckPort } from './ports/health-check.port.js';
import type { StorageReadiness, StorageReadinessPort } from './ports/storage-readiness.port.js';
import { GetHealthUseCase } from './get-health.use-case.js';

class FakeHealthCheckPort implements HealthCheckPort {
  constructor(private readonly result: boolean) {}

  check(): Promise<boolean> {
    return Promise.resolve(this.result);
  }
}

class FakeStorageReadinessPort implements StorageReadinessPort {
  constructor(private readonly result: StorageReadiness) {}

  check(): Promise<StorageReadiness> {
    return Promise.resolve(this.result);
  }
}

const storage = (result: StorageReadiness) => new FakeStorageReadinessPort(result);

describe('GetHealthUseCase', () => {
  it('returns status "up" when the port reports healthy', async () => {
    const useCase = new GetHealthUseCase(new FakeHealthCheckPort(true), storage('skipped'));

    const report = await useCase.execute();

    expect(report.status).toBe('up');
    expect(typeof report.uptimeSeconds).toBe('number');
    expect(typeof report.checkedAt).toBe('string');
  });

  it('returns status "down" when the port reports unhealthy', async () => {
    const useCase = new GetHealthUseCase(new FakeHealthCheckPort(false), storage('up'));

    const report = await useCase.execute();

    expect(report.status).toBe('down');
  });

  it('reports storage up and keeps readiness up', async () => {
    const report = await new GetHealthUseCase(
      new FakeHealthCheckPort(true),
      storage('up'),
    ).execute();

    expect(report.status).toBe('up');
    expect(report.storage).toBe('up');
  });

  it('reports storage down and fails readiness', async () => {
    const report = await new GetHealthUseCase(
      new FakeHealthCheckPort(true),
      storage('down'),
    ).execute();

    expect(report.status).toBe('down');
    expect(report.storage).toBe('down');
  });

  it('reports storage skipped without failing readiness', async () => {
    const report = await new GetHealthUseCase(
      new FakeHealthCheckPort(true),
      storage('skipped'),
    ).execute();

    expect(report.status).toBe('up');
    expect(report.storage).toBe('skipped');
  });
});
