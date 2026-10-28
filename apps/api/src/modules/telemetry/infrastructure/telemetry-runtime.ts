import type { IncomingMessage, ServerResponse } from 'node:http';
import type { SpanExporter } from '@opentelemetry/sdk-trace';
import type { Telemetry } from '../application/ports/telemetry.port.js';
import { NOOP_TELEMETRY } from './noop-telemetry.js';
import { createOtelTelemetry } from './otel-telemetry.js';
import { loadTelemetryConfig, type TelemetryConfig } from './telemetry-config.js';

export interface TelemetryRuntime {
  readonly config: TelemetryConfig;
  readonly telemetry: Telemetry;
  /** True only with `NODE_ENV` exactly `development` or `test`: the only place `/metrics` may be open. */
  readonly metricsOpen: boolean;
  /** Present only when `METRICS_ENABLED=true`. */
  readonly metricsHandler:
    ((request: IncomingMessage, response: ServerResponse) => void) | undefined;
  shutdown(): Promise<void>;
}

/** The API and the worker build their telemetry here: a no-op unless the environment turns it on. */
export function createTelemetryRuntime(
  env: NodeJS.ProcessEnv,
  options: { spanExporter?: SpanExporter } = {},
): TelemetryRuntime {
  const config = loadTelemetryConfig(env);
  const metricsOpen = env.NODE_ENV === 'development' || env.NODE_ENV === 'test';
  if (!config.tracing && !config.metrics) {
    return {
      config,
      metricsOpen,
      telemetry: NOOP_TELEMETRY,
      metricsHandler: undefined,
      shutdown: () => Promise.resolve(),
    };
  }
  const otel = createOtelTelemetry(config, options);
  return {
    config,
    metricsOpen,
    telemetry: otel.telemetry,
    metricsHandler: config.metrics ? otel.metricsHandler : undefined,
    shutdown: () => otel.shutdown(),
  };
}
