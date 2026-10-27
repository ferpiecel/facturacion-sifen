import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  context,
  trace,
  SpanStatusCode,
  defaultTextMapGetter,
  defaultTextMapSetter,
  type Meter,
  type ObservableGauge,
} from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { PrometheusExporter } from '@opentelemetry/exporter-prometheus';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { MeterProvider } from '@opentelemetry/sdk-metrics';
import {
  BatchSpanProcessor,
  SimpleSpanProcessor,
  TracerProvider,
  type SpanExporter,
} from '@opentelemetry/sdk-trace';
import type { Telemetry } from '../application/ports/telemetry.port.js';
import {
  allowedLabels,
  METRIC_CATALOG,
  type Labels,
  type MetricName,
} from '../domain/metric-catalog.js';
import type { TelemetryConfig } from './telemetry-config.js';

export interface OtelTelemetry {
  readonly telemetry: Telemetry;
  /** Serves the Prometheus text exposition; the caller authenticates. */
  readonly metricsHandler: (request: IncomingMessage, response: ServerResponse) => void;
  shutdown(): Promise<void>;
}

const SECONDS_BUCKETS = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300];
const propagator = new W3CTraceContextPropagator();

/**
 * Builds the OpenTelemetry SDK behind the {@link Telemetry} port. Metrics go to an in-process
 * Prometheus reader (no listener of its own); spans go to OTLP/HTTP only when tracing is enabled.
 * `spanExporter` replaces OTLP in tests.
 */
export function createOtelTelemetry(
  config: TelemetryConfig,
  options: { spanExporter?: SpanExporter } = {},
): OtelTelemetry {
  const resource = resourceFromAttributes({ 'service.name': config.serviceName });
  const reader = new PrometheusExporter({ preventServerStart: true });
  const meterProvider = new MeterProvider({ resource, readers: [reader] });
  const meter = meterProvider.getMeter('sifen');

  const exporter =
    options.spanExporter ??
    (config.tracing
      ? new OTLPTraceExporter({ url: `${config.otlpEndpoint ?? ''}/v1/traces` })
      : undefined);
  const processors = exporter
    ? [
        options.spanExporter
          ? new SimpleSpanProcessor({ exporter })
          : new BatchSpanProcessor({ exporter }),
      ]
    : [];
  const tracerProvider = new TracerProvider({ resource, spanProcessors: processors });
  const tracer = tracerProvider.getTracer('sifen');
  console.log('P', processors.length, config.tracing);
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());

  const counters = new Map<string, ReturnType<Meter['createCounter']>>();
  const histograms = new Map<string, ReturnType<Meter['createHistogram']>>();
  const gaugeValues = new Map<MetricName, Map<string, { labels: Labels; value: number }>>();
  const gauges = new Map<string, ObservableGauge>();

  const instrument = <T>(cache: Map<string, T>, name: string, create: () => T): T => {
    const found = cache.get(name);
    if (found) return found;
    const created = create();
    cache.set(name, created);
    return created;
  };

  const telemetry: Telemetry = {
    increment(name, by = 1, labels) {
      instrument(counters, name, () =>
        meter.createCounter(name, { description: METRIC_CATALOG[name].description }),
      ).add(by, allowedLabels(name, labels));
    },
    observe(name, value, labels) {
      instrument(histograms, name, () =>
        meter.createHistogram(name, {
          description: METRIC_CATALOG[name].description,
          advice: { explicitBucketBoundaries: SECONDS_BUCKETS },
        }),
      ).record(value, allowedLabels(name, labels));
    },
    setGauge(name, value, labels) {
      const clean = allowedLabels(name, labels);
      const series = gaugeValues.get(name) ?? new Map<string, { labels: Labels; value: number }>();
      gaugeValues.set(name, series);
      series.set(JSON.stringify(clean), { labels: clean, value });
      instrument(gauges, name, () => {
        const gauge = meter.createObservableGauge(name, {
          description: METRIC_CATALOG[name].description,
        });
        gauge.addCallback((result) => {
          for (const point of gaugeValues.get(name)?.values() ?? []) {
            result.observe(point.value, point.labels);
          }
        });
        return gauge;
      });
    },
    async withSpan(name, attributes, fn, traceparent) {
      const parent = traceparent
        ? propagator.extract(context.active(), { traceparent }, defaultTextMapGetter)
        : context.active();
      const span = tracer.startSpan(name, { attributes }, parent);
      try {
        return await context.with(trace.setSpan(parent, span), () =>
          fn({ traceId: span.spanContext().traceId }),
        );
      } catch (error) {
        span.setStatus({ code: SpanStatusCode.ERROR });
        // The class name only: messages carry URLs, SQL and payload fragments.
        span.setAttribute('error.type', error instanceof Error ? error.name : 'unknown');
        throw error;
      } finally {
        span.end();
      }
    },
    traceparent() {
      const current = trace.getSpan(context.active());
      if (!current) return undefined;
      const carrier: Record<string, string> = {};
      propagator.inject(context.active(), carrier, defaultTextMapSetter);
      return carrier.traceparent;
    },
  };

  return {
    telemetry,
    metricsHandler: (request, response) => {
      reader.getMetricsRequestHandler(request, response);
    },
    async shutdown() {
      await tracerProvider.shutdown();
      await meterProvider.shutdown();
      context.disable();
    },
  };
}
