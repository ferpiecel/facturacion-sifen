import { describe, expect, it } from 'vitest';
import { readReceiverEventConfig } from './receiver-event-config.js';

/** Spec: HU-E9-01. Deadlines in dispute are configuration, not constants. */
describe('readReceiverEventConfig', () => {
  it('defaults to the 45 and 15 days of NT 019 and MT Tabla K', () => {
    expect(readReceiverEventConfig({})).toMatchObject({ windowDays: 45, correctionDays: 15 });
  });

  it('reads both deadlines from the environment', () => {
    const env = { RECEIVER_EVENT_WINDOW_DAYS: '30', RECEIVER_EVENT_CORRECTION_DAYS: '10' };
    expect(readReceiverEventConfig(env)).toMatchObject({ windowDays: 30, correctionDays: 10 });
  });

  it.each(['0', '-1', '1.5', 'abc', '366'])('fails fast on %s', (value) => {
    expect(() => readReceiverEventConfig({ RECEIVER_EVENT_WINDOW_DAYS: value })).toThrow(
      'RECEIVER_EVENT_WINDOW_DAYS',
    );
  });
});
