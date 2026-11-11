import {
  FakeSifenGateway,
  SifenTenantUnavailableError,
  SifenTransportError,
  type SifenGateway,
} from '@sifen/sifen-gateway';
import { describe, expect, it, vi } from 'vitest';
import type { Telemetry } from '../modules/telemetry/application/ports/telemetry.port.js';
import { WorkerConfigError } from './worker-config.js';
import { createWorkerSifen, GATEWAY_CACHE_MAX, type WorkerSifenDeps } from './worker-gateway.js';

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
    ).rejects.toBeInstanceOf(SifenTenantUnavailableError);
  });

  it('never lets one tenant without a certificate pause sends for the others', async () => {
    const sifen = createWorkerSifen({ SIFEN_GATEWAY: 'soap' }, deps);
    for (let i = 0; i < 6; i++) {
      await sifen
        .gatewayFor('t-1')
        .enviarLote({ dId: 1n, des: ['<x/>'] })
        .catch(() => undefined);
    }
    expect(sifen.sendPausedUntil()).toBeNull();
  });

  describe('gateway memoization (HU-E14-01)', () => {
    it('builds one decorated gateway per tenant and reuses it', () => {
      const decorate = vi.fn((gateway: SifenGateway) => gateway);
      const sifen = createWorkerSifen({ SIFEN_GATEWAY: 'soap' }, { ...deps, decorate });
      expect(sifen.gatewayFor('t-1')).toBe(sifen.gatewayFor('t-1'));
      expect(sifen.gatewayFor('t-2')).not.toBe(sifen.gatewayFor('t-1'));
      expect(decorate).toHaveBeenCalledTimes(2);
    });

    it('evicts the least recently used tenant beyond the bound', () => {
      const decorate = vi.fn((gateway: SifenGateway) => gateway);
      const sifen = createWorkerSifen({ SIFEN_GATEWAY: 'soap' }, { ...deps, decorate });
      for (let i = 0; i < GATEWAY_CACHE_MAX + 1; i++) sifen.gatewayFor(`t-${String(i)}`);
      decorate.mockClear();
      sifen.gatewayFor('t-0');
      expect(decorate).toHaveBeenCalledTimes(1);
      sifen.gatewayFor(`t-${String(GATEWAY_CACHE_MAX)}`);
      expect(decorate).toHaveBeenCalledTimes(1);
    });
  });

  describe('decorate (HU-E14-01)', () => {
    const simulator = { SIFEN_GATEWAY: 'simulator', NODE_ENV: 'test' };
    const failing: SifenGateway = new Proxy({} as SifenGateway, {
      get: (_t, operation) => () =>
        Promise.reject(new SifenTransportError(operation as 'enviarLote')),
    });

    it('wraps the simulator beneath the shared breaker', async () => {
      let inner: SifenGateway | undefined;
      let calls = 0;
      const sifen = createWorkerSifen(simulator, {
        ...deps,
        decorate: (gateway) => {
          inner = gateway;
          return new Proxy(gateway, {
            get: (target, key, receiver) => {
              calls += 1;
              return Reflect.get(target, key, receiver) as unknown;
            },
          });
        },
      });
      expect(inner).toBeInstanceOf(FakeSifenGateway);
      await sifen.gatewayFor('t-1').consultarRUC({ dId: 1n, ruc: '80000001-0' });
      expect(calls).toBeGreaterThan(0);
    });

    it('counts only calls that reach SIFEN: an open circuit short-circuits above the decorator', async () => {
      let reached = 0;
      const sifen = createWorkerSifen(simulator, {
        ...deps,
        decorate: () =>
          new Proxy(failing, {
            get: (target, key, receiver) => {
              reached += 1;
              return Reflect.get(target, key, receiver) as unknown;
            },
          }),
      });
      for (let i = 0; i < 10; i++) {
        await sifen
          .gatewayFor('t-1')
          .enviarLote({ dId: 1n, des: ['<x/>'] })
          .catch(() => undefined);
      }
      expect(sifen.sendPausedUntil()).not.toBeNull();
      expect(reached).toBeLessThan(10);
    });

    it('publishes sifen_circuit_state on every transition', async () => {
      const setGauge = vi.fn();
      const sifen = createWorkerSifen(simulator, {
        ...deps,
        telemetry: { setGauge } as unknown as Telemetry,
        decorate: () => failing,
      });
      for (let i = 0; i < 6; i++) {
        await sifen
          .gatewayFor('t-1')
          .enviarLote({ dId: 1n, des: ['<x/>'] })
          .catch(() => undefined);
      }
      expect(setGauge).toHaveBeenCalledWith('sifen_circuit_state', 2, { operation: 'enviarLote' });
    });

    it('decorates each tenant gateway beneath the breaker on the SOAP path', async () => {
      const tenants: SifenGateway[] = [];
      const sifen = createWorkerSifen(
        { SIFEN_GATEWAY: 'soap' },
        {
          ...deps,
          decorate: (gateway) => {
            tenants.push(gateway);
            return gateway;
          },
        },
      );
      await sifen
        .gatewayFor('t-1')
        .enviarLote({ dId: 1n, des: ['<x/>'] })
        .catch(() => undefined);
      expect(tenants.length).toBeGreaterThan(0);
    });
  });
});
