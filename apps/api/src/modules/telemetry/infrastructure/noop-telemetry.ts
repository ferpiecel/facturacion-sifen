import type { Telemetry } from '../application/ports/telemetry.port.js';

export const NOOP_TELEMETRY: Telemetry = {
  increment: () => undefined,
  observe: () => undefined,
  setGauge: () => undefined,
  withSpan: (_name, _attributes, fn) => fn({ traceId: '' }),
  traceparent: () => undefined,
};
