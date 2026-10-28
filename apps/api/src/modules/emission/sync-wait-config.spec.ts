import { describe, expect, it } from 'vitest';
import { parseSyncWaitTimeoutMs } from './sync-wait-config.js';

/** Spec: HU-E6-06, `SYNC_WAIT_TIMEOUT_MS` defaults to 30000, 1000 to 30000, fail-fast. */
describe('parseSyncWaitTimeoutMs', () => {
  it('defaults to 30 s', () => {
    expect(parseSyncWaitTimeoutMs({})).toBe(30_000);
  });
  it('accepts values in range', () => {
    expect(parseSyncWaitTimeoutMs({ SYNC_WAIT_TIMEOUT_MS: '1000' })).toBe(1_000);
    expect(parseSyncWaitTimeoutMs({ SYNC_WAIT_TIMEOUT_MS: '30000' })).toBe(30_000);
  });
  it.each(['999', '30001', 'abc', '1.5', '', '-1'])('rejects %j', (value) => {
    expect(() => parseSyncWaitTimeoutMs({ SYNC_WAIT_TIMEOUT_MS: value })).toThrow(
      /SYNC_WAIT_TIMEOUT_MS/,
    );
  });
});
