import { SifenCircuitOpenError } from '@sifen/sifen-gateway';
import { describe, expect, it } from 'vitest';
import { WorkerConfigError } from './worker-config.js';
import { createWorkerSifen, type WorkerSifenDeps } from './worker-gateway.js';

const deps: WorkerSifenDeps = {
  logger: { warn: () => undefined },
  readFile: () => '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n',
  environments: { environmentOf: () => Promise.resolve('test') },
  certificates: { open: () => Promise.reject(new Error('no certificate')) },
};

/** Spec: HU-E6-02 (S5e). The worker never silently transmits against a simulator. */
describe('createWorkerSifen', () => {
  it('refuses to start without an explicit gateway', () => {
    expect(() => createWorkerSifen({}, deps)).toThrow(WorkerConfigError);
    expect(() => createWorkerSifen({ SIFEN_GATEWAY: 'carrier-pigeon' }, deps)).toThrow(
      'no SIFEN gateway adapter is available for SIFEN_GATEWAY',
    );
  });

  it('allows the simulator outside production only', () => {
    expect(
      createWorkerSifen({ SIFEN_GATEWAY: 'simulator', NODE_ENV: 'development' }, deps).simulator,
    ).toBe(true);
    expect(() =>
      createWorkerSifen({ SIFEN_GATEWAY: 'simulator', NODE_ENV: 'production' }, deps),
    ).toThrow('the simulator gateway is not allowed in production');
    expect(() => createWorkerSifen({ SIFEN_GATEWAY: 'simulator' }, deps)).toThrow(
      'the simulator gateway is not allowed in production',
    );
  });

  it('builds the SOAP gateway, valid in production, and is not a simulator', () => {
    const sifen = createWorkerSifen({ SIFEN_GATEWAY: 'soap', NODE_ENV: 'production' }, deps);
    expect(sifen.simulator).toBe(false);
    expect(sifen.gatewayFor('t-1')).toBeDefined();
  });

  it('fails fast on an invalid SOAP setting', () => {
    expect(() =>
      createWorkerSifen({ SIFEN_GATEWAY: 'soap', SIFEN_SOAP_TIMEOUT_MS: 'x' }, deps),
    ).toThrow(WorkerConfigError);
  });

  it('reports no paused send while every circuit is closed', () => {
    expect(createWorkerSifen({ SIFEN_GATEWAY: 'soap' }, deps).sendPausedUntil()).toBeNull();
  });

  it('defers a tenant whose certificate is unavailable, without reaching SIFEN', async () => {
    const sifen = createWorkerSifen({ SIFEN_GATEWAY: 'soap' }, deps);
    await expect(
      sifen.gatewayFor('t-1').enviarLote({ dId: 1n, des: ['<x/>'] }),
    ).rejects.toBeInstanceOf(SifenCircuitOpenError);
  });
});
