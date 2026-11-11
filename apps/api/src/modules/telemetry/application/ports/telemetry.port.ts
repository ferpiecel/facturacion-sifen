import type { Labels, MetricName } from '../../domain/metric-catalog.js';

/** Span attributes: operation names, codes and ids only, never XML, certificates, URLs or PII. */
export type SpanAttributes = Readonly<Record<string, string | number | boolean>>;

export interface ActiveSpan {
  /** 32 hex characters, or empty when tracing is off. */
  readonly traceId: string;
}

/**
 * Vendor-neutral observability port (OpenTelemetry behind it, HU-E14-01). Every method is safe to
 * call when observability is off: the no-op adapter does nothing and `fn` still runs.
 */
export interface Telemetry {
  increment(name: MetricName, by?: number, labels?: Labels): void;
  observe(name: MetricName, value: number, labels?: Labels): void;
  setGauge(name: MetricName, value: number, labels?: Labels): void;
  /**
   * Runs `fn` inside a span, a child of the current one or of `traceparent` (W3C) when given. A
   * thrown error marks the span failed with its class name only and is rethrown.
   */
  withSpan<T>(
    name: string,
    attributes: SpanAttributes,
    fn: (span: ActiveSpan) => Promise<T>,
    traceparent?: string,
  ): Promise<T>;
  /** The W3C `traceparent` of the current span, to carry in job data; undefined outside a span. */
  traceparent(): string | undefined;
}
