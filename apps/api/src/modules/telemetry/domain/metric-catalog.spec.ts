import { describe, expect, it } from 'vitest';
import { NOOP_TELEMETRY } from '../infrastructure/noop-telemetry.js';
import { allowedLabels, METRIC_CATALOG } from './metric-catalog.js';

/** Spec: HU-E14-01. Labels are whitelisted per metric: no tenant id, CDC or free text. */
describe('metric catalog', () => {
  it('keeps only the declared label keys', () => {
    expect(
      allowedLabels('sifen_rejections_total', { codigo: '2001', tenant_id: 'x', cdc: 'y' }),
    ).toEqual({ codigo: '2001' });
    expect(allowedLabels('sifen_ruc_blocks_total', { codigo: '0160' })).toEqual({});
    expect(allowedLabels('sifen_ruc_blocks_total', undefined)).toEqual({});
  });

  it('never declares a tenant, document or URL label', () => {
    const keys = Object.values(METRIC_CATALOG).flatMap((metric) => [...metric.labels]);
    expect(keys.filter((key) => /tenant|cdc|url|email|ruc$/.test(key))).toEqual([]);
  });

  it('has a no-op adapter that still runs the traced work', async () => {
    NOOP_TELEMETRY.increment('sifen_ruc_blocks_total');
    NOOP_TELEMETRY.observe('sifen_request_seconds', 1);
    NOOP_TELEMETRY.setGauge('sifen_ruc_blocked_tenants', 0);
    await expect(
      NOOP_TELEMETRY.withSpan('x', {}, (span) => Promise.resolve(span.traceId)),
    ).resolves.toBe('');
    expect(NOOP_TELEMETRY.traceparent()).toBeUndefined();
  });
});
