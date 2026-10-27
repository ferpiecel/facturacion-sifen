/** Invalid observability environment. Messages never carry the offending value (endpoints and tokens are secrets). */
export class TelemetryConfigError extends Error {
  override name = 'TelemetryConfigError';
}

export interface TelemetryConfig {
  /** Export traces over OTLP/HTTP (`OTEL_ENABLED`). Off by default. */
  readonly tracing: boolean;
  readonly otlpEndpoint: string | undefined;
  /** Expose Prometheus metrics (`METRICS_ENABLED`). Off by default. */
  readonly metrics: boolean;
  /** Bearer token protecting `/metrics` on the API. */
  readonly metricsToken: string | undefined;
  /** Port of the worker's own metrics listener. */
  readonly metricsPort: number;
  readonly serviceName: string;
}

const MIN_TOKEN_LENGTH = 16;

function flag(env: NodeJS.ProcessEnv, name: string): boolean {
  const raw = env[name];
  if (raw === undefined || raw === '') return false;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new TelemetryConfigError(`${name} must be true or false`);
}

function endpoint(env: NodeJS.ProcessEnv): string | undefined {
  const raw = env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!raw) return undefined;
  let protocol = '';
  try {
    ({ protocol } = new URL(raw));
  } catch {
    // reported below without the value
  }
  if (protocol !== 'http:' && protocol !== 'https:') {
    throw new TelemetryConfigError(
      'OTEL_EXPORTER_OTLP_ENDPOINT must be an http:// or https:// URL',
    );
  }
  return raw;
}

function port(env: NodeJS.ProcessEnv): number {
  const raw = env.METRICS_PORT;
  if (raw === undefined || raw === '') return 9464;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1024 || value > 65_535) {
    throw new TelemetryConfigError('METRICS_PORT is out of range');
  }
  return value;
}

/** Reads the observability settings (docs/configuracion.md); everything is off unless asked for. */
export function loadTelemetryConfig(env: NodeJS.ProcessEnv): TelemetryConfig {
  const tracing = flag(env, 'OTEL_ENABLED');
  const metrics = flag(env, 'METRICS_ENABLED');
  const otlpEndpoint = endpoint(env);
  if (tracing && !otlpEndpoint) {
    throw new TelemetryConfigError(
      'OTEL_EXPORTER_OTLP_ENDPOINT is required when OTEL_ENABLED=true',
    );
  }
  const metricsToken = env.METRICS_TOKEN || undefined;
  if (
    metrics &&
    env.NODE_ENV !== 'development' &&
    env.NODE_ENV !== 'test' &&
    env.NODE_ENV !== undefined &&
    (metricsToken?.length ?? 0) < MIN_TOKEN_LENGTH
  ) {
    throw new TelemetryConfigError(
      `METRICS_TOKEN of at least ${String(MIN_TOKEN_LENGTH)} characters is required in production`,
    );
  }
  return {
    tracing,
    otlpEndpoint,
    metrics,
    metricsToken,
    metricsPort: port(env),
    serviceName: env.OTEL_SERVICE_NAME || 'sifen-api',
  };
}
