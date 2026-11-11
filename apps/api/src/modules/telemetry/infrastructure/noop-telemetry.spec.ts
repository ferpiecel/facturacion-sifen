import { describe, expect, it } from 'vitest';
import { NOOP_TELEMETRY } from './noop-telemetry.js';

/** Spec: HU-E14-01. */
describe('NOOP_TELEMETRY', () => {
  it('does nothing yet still runs the traced work', async () => {
    NOOP_TELEMETRY.increment('sifen_ruc_blocks_total');
    NOOP_TELEMETRY.observe('sifen_request_seconds', 1);
    NOOP_TELEMETRY.setGauge('sifen_ruc_blocked_tenants', 0);
    await expect(
      NOOP_TELEMETRY.withSpan('x', {}, (span) => Promise.resolve(span.traceId)),
    ).resolves.toBe('');
    expect(NOOP_TELEMETRY.traceparent()).toBeUndefined();
  });
});
