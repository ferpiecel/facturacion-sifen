import { describe, expect, it } from 'vitest';
import { loadTelemetryConfig, TelemetryConfigError } from './telemetry-config.js';

/** Spec: HU-E14-01. Observability is off unless configured, and misconfiguration fails at startup. */
describe('loadTelemetryConfig', () => {
  it('is off by default', () => {
    expect(loadTelemetryConfig({})).toEqual({
      tracing: false,
      otlpEndpoint: undefined,
      metrics: false,
      metricsToken: undefined,
      metricsPort: 9464,
      serviceName: 'sifen-api',
    });
  });

  it('enables tracing only with a valid OTLP endpoint', () => {
    expect(() => loadTelemetryConfig({ OTEL_ENABLED: 'true' })).toThrow(
      new TelemetryConfigError('OTEL_EXPORTER_OTLP_ENDPOINT is required when OTEL_ENABLED=true'),
    );
    expect(() =>
      loadTelemetryConfig({ OTEL_ENABLED: 'true', OTEL_EXPORTER_OTLP_ENDPOINT: 'ftp://s3cret' }),
    ).toThrow('OTEL_EXPORTER_OTLP_ENDPOINT must be an http:// or https:// URL');
    expect(
      loadTelemetryConfig({
        OTEL_ENABLED: 'true',
        OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector:4318',
      }),
    ).toMatchObject({ tracing: true, otlpEndpoint: 'https://collector:4318' });
  });

  it('rejects non-boolean switches and never echoes the offending value', () => {
    for (const env of [{ OTEL_ENABLED: 'yes-s3cret' }, { METRICS_ENABLED: 'maybe-s3cret' }]) {
      expect(() => loadTelemetryConfig(env)).toThrow(TelemetryConfigError);
      try {
        loadTelemetryConfig(env);
      } catch (error) {
        expect(String(error)).not.toContain('s3cret');
      }
    }
  });

  it('requires a token of at least 16 characters to expose metrics in production', () => {
    expect(() => loadTelemetryConfig({ METRICS_ENABLED: 'true', NODE_ENV: 'production' })).toThrow(
      'METRICS_TOKEN of at least 16 characters is required in production',
    );
    expect(
      loadTelemetryConfig({
        METRICS_ENABLED: 'true',
        NODE_ENV: 'production',
        METRICS_TOKEN: 'a'.repeat(16),
      }),
    ).toMatchObject({ metrics: true, metricsToken: 'a'.repeat(16) });
    expect(loadTelemetryConfig({ METRICS_ENABLED: 'true', NODE_ENV: 'development' })).toMatchObject(
      { metrics: true },
    );
  });

  it('does not treat an unset or unknown NODE_ENV as permissive', () => {
    for (const NODE_ENV of [undefined, '', 'staging']) {
      expect(() => loadTelemetryConfig({ METRICS_ENABLED: 'true', NODE_ENV })).toThrow(
        'METRICS_TOKEN of at least 16 characters is required',
      );
    }
  });

  it('bounds the worker metrics port and names the service', () => {
    expect(() => loadTelemetryConfig({ METRICS_PORT: '80' })).toThrow(
      'METRICS_PORT is out of range',
    );
    expect(
      loadTelemetryConfig({ METRICS_PORT: '9100', OTEL_SERVICE_NAME: 'sifen-worker' }),
    ).toMatchObject({
      metricsPort: 9100,
      serviceName: 'sifen-worker',
    });
  });
});
