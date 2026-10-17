import { FakeSifenGateway, SifenTransportError } from '@sifen/sifen-gateway';
import { describe, expect, it } from 'vitest';
import { withCircuitBreaker } from './resilient-gateway.js';

/** Spec: HU-E6-08. The worker's gateway is wrapped by one circuit breaker per SIFEN endpoint. */
describe('withCircuitBreaker', () => {
  const request = { dId: 1n, des: ['<x/>'] };

  it('logs a circuit that opens and one that closes again, by operation only', async () => {
    const inner = new FakeSifenGateway();
    inner.enqueue(
      'enviarLote',
      ...Array.from({ length: 5 }, () => new SifenTransportError('enviarLote')),
    );
    let t = 0;
    const warnings: string[] = [];
    const { gateway } = withCircuitBreaker(inner, {
      logger: { warn: (m) => warnings.push(m) },
      now: () => new Date(t),
    });
    for (let i = 0; i < 5; i += 1) await gateway.enviarLote(request).catch(() => undefined);
    t = 30_000;
    await gateway.enviarLote(request);
    expect(warnings).toEqual([
      'SIFEN circuit enviarLote: closed -> open',
      'SIFEN circuit enviarLote: open -> half-open',
      'SIFEN circuit enviarLote: half-open -> closed',
    ]);
  });

  it('exposes when the send endpoint may be tried again', async () => {
    const inner = new FakeSifenGateway();
    inner.setDefault('enviarLote', new SifenTransportError('enviarLote'));
    const { gateway, sendPausedUntil } = withCircuitBreaker(inner, {
      logger: { warn: () => undefined },
      now: () => new Date(0),
    });
    expect(sendPausedUntil()).toBeNull();
    for (let i = 0; i < 5; i += 1) await gateway.enviarLote(request).catch(() => undefined);
    expect(sendPausedUntil()).toEqual(new Date(30_000));
  });
});
