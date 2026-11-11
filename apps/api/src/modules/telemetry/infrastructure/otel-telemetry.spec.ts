import type { ServerResponse } from 'node:http';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createOtelTelemetry, otlpTracesUrl, type OtelTelemetry } from './otel-telemetry.js';

const config = {
  tracing: false,
  otlpEndpoint: undefined,
  metrics: true,
  metricsToken: undefined,
  metricsPort: 9464,
  metricsHost: '127.0.0.1',
  serviceName: 'sifen-test',
};

function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('span not found');
  return value;
}

async function scrape(otel: OtelTelemetry): Promise<string> {
  return new Promise((resolve) => {
    const response = {
      statusCode: 0,
      setHeader: () => undefined,
      end: (body: string) => {
        resolve(body);
      },
    } as unknown as ServerResponse;
    otel.metricsHandler({} as never, response);
  });
}

/** Spec: HU-E14-01. OpenTelemetry adapter behind the Telemetry port. */
describe('createOtelTelemetry', () => {
  let exporter = new InMemorySpanExporter();
  let otel: OtelTelemetry | undefined;
  beforeEach(() => {
    exporter = new InMemorySpanExporter();
  });
  afterEach(async () => {
    await otel?.shutdown();
  });

  it('exposes counters, histograms and gauges in Prometheus format', async () => {
    otel = createOtelTelemetry(config, { spanExporter: exporter });
    otel.telemetry.increment('sifen_lote_status_total', 2, { codigo: '0362' });
    otel.telemetry.observe('sifen_request_seconds', 0.3, { operation: 'enviarLote' });
    otel.telemetry.setGauge('de_pending_transmission', 4, { bucket: '48-72h' });
    otel.telemetry.setGauge('de_pending_transmission', 1, { bucket: '48-72h' });
    const text = await scrape(otel);
    expect(text).toContain('sifen_lote_status_total{codigo="0362"');
    expect(text).toMatch(/sifen_lote_status_total\{[^}]*\} 2/);
    expect(text).toContain('sifen_request_seconds_bucket');
    expect(text).toMatch(/de_pending_transmission\{[^}]*bucket="48-72h"[^}]*\} 1\n/);
  });

  it('drops any label the catalog does not declare', async () => {
    otel = createOtelTelemetry(config, { spanExporter: exporter });
    otel.telemetry.increment('sifen_rejections_total', 1, {
      codigo: '2001',
      tenant_id: '0b7e0c9e-0000-4000-8000-000000000001',
      cdc: '01800000000001001001000000112026',
    });
    const text = await scrape(otel);
    expect(text).toContain('codigo="2001"');
    expect(text).not.toContain('tenant_id');
    expect(text).not.toContain('cdc');
  });

  it('nests spans, marks failures by class name and links a remote traceparent', async () => {
    otel = createOtelTelemetry({ ...config, tracing: true }, { spanExporter: exporter });
    const { telemetry } = otel;
    let carried: string | undefined;
    await telemetry.withSpan('cycle', { 'tenant.id': 't1' }, async (cycle) => {
      carried = telemetry.traceparent();
      expect(carried).toContain(cycle.traceId);
      await telemetry
        .withSpan('sifen.enviarLote', {}, () =>
          Promise.reject(new TypeError('boom https://x?k=secret')),
        )
        .catch(() => undefined);
    });
    await new Promise((r) => setTimeout(r, 20));
    const spans = exporter.getFinishedSpans();
    const child = must(spans.find((s) => s.name === 'sifen.enviarLote'));
    const root = must(spans.find((s) => s.name === 'cycle'));
    expect(child.spanContext().traceId).toBe(root.spanContext().traceId);
    expect(child.attributes['error.type']).toBe('TypeError');
    expect(JSON.stringify([child.attributes, child.events, child.status])).not.toContain('secret');

    await telemetry.withSpan('worker.job', {}, () => Promise.resolve(), carried);
    const job = must(exporter.getFinishedSpans().find((s) => s.name === 'worker.job'));
    expect(job.spanContext().traceId).toBe(root.spanContext().traceId);
  });

  it('has no current traceparent outside a span', () => {
    otel = createOtelTelemetry(config, { spanExporter: exporter });
    expect(otel.telemetry.traceparent()).toBeUndefined();
  });
});

describe('otlpTracesUrl', () => {
  it('appends the traces path once, whatever the trailing slashes', () => {
    expect(otlpTracesUrl('http://collector:4318')).toBe('http://collector:4318/v1/traces');
    expect(otlpTracesUrl('http://collector:4318/')).toBe('http://collector:4318/v1/traces');
    expect(otlpTracesUrl('http://collector:4318//')).toBe('http://collector:4318/v1/traces');
  });
});
