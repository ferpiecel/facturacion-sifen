import { FakeSifenGateway } from '@sifen/sifen-gateway';
import { describe, expect, it } from 'vitest';
import { WorkerConfigError } from './worker-config.js';
import { createWorkerGateway } from './worker-gateway.js';

/** Spec: HU-E6-02 (S5e). The worker never silently transmits against a simulator. */
describe('createWorkerGateway', () => {
  it('has no real SIFEN adapter yet, so it refuses to start without an explicit simulator', () => {
    expect(() => createWorkerGateway({})).toThrow(WorkerConfigError);
    expect(() => createWorkerGateway({ SIFEN_GATEWAY: 'soap' })).toThrow(
      'no SIFEN gateway adapter is available for SIFEN_GATEWAY',
    );
  });

  it('allows the simulator outside production only', () => {
    expect(
      createWorkerGateway({ SIFEN_GATEWAY: 'simulator', NODE_ENV: 'development' }),
    ).toBeInstanceOf(FakeSifenGateway);
    expect(() =>
      createWorkerGateway({ SIFEN_GATEWAY: 'simulator', NODE_ENV: 'production' }),
    ).toThrow('the simulator gateway is not allowed in production');
    expect(() => createWorkerGateway({ SIFEN_GATEWAY: 'simulator' })).toThrow(
      'the simulator gateway is not allowed in production',
    );
  });
});
