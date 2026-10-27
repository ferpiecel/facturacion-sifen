import { describe, expect, it } from 'vitest';
import { SifenFaultError, SifenTimeoutError, SifenTransportError } from '../errors.ts';
import { FakeSifenGateway } from '../fake/fake-sifen-gateway.ts';
import { CircuitBreakerGateway, SifenCircuitOpenError } from './circuit-breaker-gateway.ts';
import { loteRecibido } from '../fake/scenarios.ts';

const options = { failureThreshold: 2, baseOpenMs: 1_000, maxOpenMs: 4_000 };
const lote = { dId: 1n, des: ['<xDE/>'] };
const consulta = { dId: 2n, cdc: '0'.repeat(44) as never };

function build(now = () => new Date(0)) {
  const inner = new FakeSifenGateway();
  const gateway = new CircuitBreakerGateway(inner, { ...options, now });
  return { inner, gateway };
}

describe('CircuitBreakerGateway', () => {
  it('passes answers through untouched', async () => {
    const { gateway, inner } = build();
    inner.enqueue('enviarLote', loteRecibido('77'));
    await expect(gateway.enviarLote(lote)).resolves.toMatchObject({ dProtConsLote: '77' });
  });

  it('opens an endpoint after consecutive transport failures and stops calling SIFEN', async () => {
    const { gateway, inner } = build();
    inner.setDefault('enviarLote', new SifenTransportError('enviarLote'));
    await expect(gateway.enviarLote(lote)).rejects.toBeInstanceOf(SifenTransportError);
    await expect(gateway.enviarLote(lote)).rejects.toBeInstanceOf(SifenTransportError);
    await expect(gateway.enviarLote(lote)).rejects.toBeInstanceOf(SifenCircuitOpenError);
    expect(inner.calls).toHaveLength(2);
  });

  it('counts timeouts as failures', async () => {
    const { gateway, inner } = build();
    inner.setDefault('enviarLote', new SifenTimeoutError('enviarLote'));
    await expect(gateway.enviarLote(lote)).rejects.toBeInstanceOf(SifenTimeoutError);
    await expect(gateway.enviarLote(lote)).rejects.toBeInstanceOf(SifenTimeoutError);
    expect(gateway.pausedUntil('enviarLote')).not.toBeNull();
  });

  it('keeps one breaker per endpoint', async () => {
    const { gateway, inner } = build();
    inner.setDefault('enviarLote', new SifenTransportError('enviarLote'));
    await gateway.enviarLote(lote).catch(() => undefined);
    await gateway.enviarLote(lote).catch(() => undefined);
    expect(gateway.pausedUntil('enviarLote')).not.toBeNull();
    expect(gateway.pausedUntil('consultarDE')).toBeNull();
    await expect(gateway.consultarDE(consulta)).resolves.toBeDefined();
  });

  it('treats a SOAP fault as a reachable endpoint', async () => {
    const { gateway, inner } = build();
    inner.setDefault('enviarLote', new SifenFaultError('enviarLote', { code: 'x', reason: 'y' }));
    for (let i = 0; i < 4; i += 1) {
      await expect(gateway.enviarLote(lote)).rejects.toBeInstanceOf(SifenFaultError);
    }
    expect(gateway.pausedUntil('enviarLote')).toBeNull();
  });

  it('carries the operation and retry time on the refusal', async () => {
    const { gateway, inner } = build();
    inner.setDefault('enviarLote', new SifenTransportError('enviarLote'));
    await gateway.enviarLote(lote).catch(() => undefined);
    await gateway.enviarLote(lote).catch(() => undefined);
    const refusal = await gateway.enviarLote(lote).catch((e: unknown) => e);
    expect(refusal).toMatchObject({
      name: 'SifenCircuitOpenError',
      operation: 'enviarLote',
      retryAt: new Date(1_000),
    });
  });

  it('probes again after the cool-down and closes on success', async () => {
    let t = 0;
    const { gateway, inner } = build(() => new Date(t));
    inner.enqueue(
      'enviarLote',
      new SifenTransportError('enviarLote'),
      new SifenTransportError('enviarLote'),
    );
    await gateway.enviarLote(lote).catch(() => undefined);
    await gateway.enviarLote(lote).catch(() => undefined);
    t = 1_000;
    await expect(gateway.enviarLote(lote)).resolves.toBeDefined();
    expect(gateway.pausedUntil('enviarLote')).toBeNull();
  });

  it('forwards the remaining operations', async () => {
    const { gateway, inner } = build();
    await gateway.consultarLote({ dId: 3n, dProtConsLote: '1' });
    await gateway.enviarDESincronico({ dId: 4n, de: '<de/>' });
    inner.setDefault('enviarEventos', { dCodRes: '0600', dMsgRes: 'ok', resultados: [] });
    await gateway.enviarEventos({ dId: 5n, eventos: ['<e/>'] });
    inner.setDefault('consultarRUC', {} as never);
    await gateway.consultarRUC({ dId: 6n, ruc: '80000000' });
    expect(inner.calls.map((call) => call.operation)).toEqual([
      'consultarLote',
      'enviarDESincronico',
      'enviarEventos',
      'consultarRUC',
    ]);
  });

  it('reports state changes with the operation', async () => {
    const changes: string[] = [];
    const inner = new FakeSifenGateway();
    const gateway = new CircuitBreakerGateway(inner, {
      ...options,
      now: () => new Date(0),
      onStateChange: (operation, from, to) => changes.push(`${operation}:${from}>${to}`),
    });
    inner.setDefault('enviarLote', new SifenTransportError('enviarLote'));
    await gateway.enviarLote(lote).catch(() => undefined);
    await gateway.enviarLote(lote).catch(() => undefined);
    expect(changes).toEqual(['enviarLote:closed>open']);
  });

  it('tells when a paused endpoint may be tried again, without consuming the probe', async () => {
    let t = 0;
    const { gateway, inner } = build(() => new Date(t));
    expect(gateway.pausedUntil('enviarLote')).toBeNull();
    inner.setDefault('enviarLote', new SifenTransportError('enviarLote'));
    await gateway.enviarLote(lote).catch(() => undefined);
    await gateway.enviarLote(lote).catch(() => undefined);
    expect(gateway.pausedUntil('enviarLote')).toEqual(new Date(1_000));
    t = 1_000;
    expect(gateway.pausedUntil('enviarLote')).toBeNull();
    expect(gateway.pausedUntil('enviarLote')).toBeNull();
  });
});

describe('CircuitBreakerGateway.around', () => {
  it('guards another gateway with the SAME breakers', async () => {
    const { gateway } = build();
    const other = new FakeSifenGateway();
    other.setDefault('enviarLote', new SifenTransportError('enviarLote'));
    const guarded = gateway.around(other);
    await guarded.enviarLote(lote).catch(() => undefined);
    await guarded.enviarLote(lote).catch(() => undefined);
    expect(gateway.pausedUntil('enviarLote')).not.toBeNull();
    await expect(gateway.enviarLote(lote)).rejects.toBeInstanceOf(SifenCircuitOpenError);
    await expect(guarded.enviarLote(lote)).rejects.toBeInstanceOf(SifenCircuitOpenError);
    expect(other.calls).toHaveLength(2);
  });
});
