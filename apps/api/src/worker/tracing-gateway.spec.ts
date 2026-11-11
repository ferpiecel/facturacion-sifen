import {
  FakeSifenGateway,
  SifenTenantUnavailableError,
  SifenTimeoutError,
  SifenTransportError,
} from '@sifen/sifen-gateway';
import { describe, expect, it } from 'vitest';
import type { Telemetry } from '../modules/telemetry/application/ports/telemetry.port.js';
import { NOOP_TELEMETRY } from '../modules/telemetry/infrastructure/noop-telemetry.js';
import { withTelemetry } from './tracing-gateway.js';

/** Spec: HU-E14-01. A decorator over the SIFEN gateway: spans, latency, response codes and errors. */
function setup() {
  const events: string[] = [];
  const telemetry: Telemetry = {
    ...NOOP_TELEMETRY,
    increment: (name, by = 1, labels) =>
      void events.push(`inc ${name} ${JSON.stringify(labels ?? {})} ${String(by)}`),
    observe: (name, _value, labels) => void events.push(`obs ${name} ${JSON.stringify(labels)}`),
    withSpan: (name, attributes, fn) => {
      events.push(`span ${name} ${JSON.stringify(attributes)}`);
      return fn({ traceId: '' });
    },
  };
  const inner = new FakeSifenGateway();
  return { events, inner, gateway: withTelemetry(inner, telemetry) };
}

describe('withTelemetry', () => {
  it('traces each call by operation, records its latency and counts the lote code', async () => {
    const { gateway, events } = setup();
    await gateway.enviarLote({ dId: 1n, des: ['<x/>'] });
    expect(events).toEqual([
      'span sifen.enviarLote {"operation":"enviarLote"}',
      'inc sifen_lote_status_total {"codigo":"0300"} 1',
      'obs sifen_request_seconds {"operation":"enviarLote"}',
    ]);
  });

  it('counts a rejected document by its response code and never a free-text code', async () => {
    const { gateway, inner, events } = setup();
    inner.enqueue('enviarDESincronico', {
      dCodRes: 'free text <x/>',
      dMsgRes: 'm',
      dEstRes: 'Rechazado',
      dProtAut: null,
    });
    await gateway.enviarDESincronico({ dId: 1n, de: '<x/>' });
    expect(events).toContain('inc sifen_rejections_total {"codigo":"other"} 1');
  });

  it('counts rejected results of a concluded lote with their first message code', async () => {
    const { gateway, inner, events } = setup();
    inner.enqueue('consultarLote', {
      dCodRes: '0362',
      dMsgRes: 'ok',
      resultados: [
        {
          cdc: '1'.repeat(44) as never,
          dEstRes: 'Rechazado',
          mensajes: [{ dCodRes: '1264', dMsgRes: 'x' }],
        },
        { cdc: '2'.repeat(44) as never, dEstRes: 'Aprobado', mensajes: [] },
      ],
    });
    await gateway.consultarLote({ dId: 1n, dProtConsLote: 'p' });
    expect(events).toContain('inc sifen_lote_status_total {"codigo":"0362"} 1');
    expect(events).toContain('inc sifen_rejections_total {"codigo":"1264"} 1');
    expect(events.filter((e) => e.includes('sifen_rejections_total'))).toHaveLength(1);
  });

  it('classifies failures by outcome, rethrows and still records the latency', async () => {
    const { gateway, inner, events } = setup();
    inner.enqueue(
      'enviarLote',
      new SifenTransportError('enviarLote'),
      new SifenTimeoutError('enviarLote'),
    );
    await expect(gateway.enviarLote({ dId: 1n, des: [] })).rejects.toBeInstanceOf(
      SifenTransportError,
    );
    await expect(gateway.enviarLote({ dId: 1n, des: [] })).rejects.toBeInstanceOf(
      SifenTimeoutError,
    );
    expect(events).toContain(
      'inc sifen_request_errors_total {"operation":"enviarLote","outcome":"transport"} 1',
    );
    expect(events).toContain(
      'inc sifen_request_errors_total {"operation":"enviarLote","outcome":"timeout"} 1',
    );
    expect(events.filter((e) => e.startsWith('obs'))).toHaveLength(2);
  });

  it('counts a call that could not start as tenant_unavailable and records no latency', async () => {
    const { gateway, inner, events } = setup();
    inner.enqueue(
      'enviarLote',
      new SifenTenantUnavailableError('enviarLote', new Date(60_000), { cause: new Error('x') }),
    );
    await expect(gateway.enviarLote({ dId: 1n, des: [] })).rejects.toBeInstanceOf(
      SifenTenantUnavailableError,
    );
    expect(events).toContain(
      'inc sifen_request_errors_total {"operation":"enviarLote","outcome":"tenant_unavailable"} 1',
    );
    expect(events.filter((e) => e.startsWith('obs'))).toHaveLength(0);
  });
});
