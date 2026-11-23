import { describe, expect, it } from 'vitest';
import { EkuatiaCircuitBreaker } from './ekuatia-circuit-breaker.js';

function harness(failureThreshold = 3, cooldownMs = 60_000) {
  const clock = { at: 1_000_000 };
  const breaker = new EkuatiaCircuitBreaker({
    failureThreshold,
    cooldownMs,
    now: () => new Date(clock.at),
  });
  return { breaker, clock };
}

describe('EkuatiaCircuitBreaker', () => {
  it('starts closed and lets every call through', () => {
    const { breaker } = harness();
    expect(breaker.state()).toBe('closed');
    expect(breaker.tryAcquire()).toBe(true);
    expect(breaker.tryAcquire()).toBe(true);
  });

  it('opens after the configured number of consecutive failures', () => {
    const { breaker } = harness(3);
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.state()).toBe('closed');
    breaker.recordFailure();
    expect(breaker.state()).toBe('open');
    expect(breaker.tryAcquire()).toBe(false);
  });

  it('a success resets the consecutive count', () => {
    const { breaker } = harness(3);
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordSuccess();
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.state()).toBe('closed');
  });

  it('opens at once on a fatal failure such as zero balance', () => {
    const { breaker } = harness(5);
    breaker.recordFatal();
    expect(breaker.state()).toBe('open');
    expect(breaker.tryAcquire()).toBe(false);
  });

  it('stays open for the cooldown and then lets exactly one probe through', () => {
    const { breaker, clock } = harness(1, 60_000);
    breaker.recordFailure();
    clock.at += 59_999;
    expect(breaker.tryAcquire()).toBe(false);
    clock.at += 1;
    expect(breaker.state()).toBe('half_open');
    expect(breaker.tryAcquire()).toBe(true);
    expect(breaker.tryAcquire()).toBe(false);
  });

  it('closes again when the probe succeeds', () => {
    const { breaker, clock } = harness(1, 60_000);
    breaker.recordFailure();
    clock.at += 60_000;
    expect(breaker.tryAcquire()).toBe(true);
    breaker.recordSuccess();
    expect(breaker.state()).toBe('closed');
    expect(breaker.tryAcquire()).toBe(true);
  });

  it('reopens for a full cooldown when the probe fails', () => {
    const { breaker, clock } = harness(5, 60_000);
    breaker.recordFatal();
    clock.at += 60_000;
    expect(breaker.tryAcquire()).toBe(true);
    breaker.recordFailure();
    expect(breaker.state()).toBe('open');
    clock.at += 59_999;
    expect(breaker.tryAcquire()).toBe(false);
    clock.at += 1;
    expect(breaker.tryAcquire()).toBe(true);
  });

  it('a released probe lets the next caller probe (nothing was learned)', () => {
    const { breaker, clock } = harness(1, 1_000);
    breaker.recordFailure();
    clock.at += 1_000;
    expect(breaker.tryAcquire()).toBe(true);
    breaker.releaseProbe();
    expect(breaker.tryAcquire()).toBe(true);
  });

  it.each([
    [{ failureThreshold: 0, cooldownMs: 1_000 }],
    [{ failureThreshold: 1.5, cooldownMs: 1_000 }],
    [{ failureThreshold: 1, cooldownMs: 0 }],
    [{ failureThreshold: 1, cooldownMs: Number.NaN }],
  ])('rejects invalid options %j', (options) => {
    expect(() => new EkuatiaCircuitBreaker({ ...options, now: () => new Date() })).toThrow(
      RangeError,
    );
  });
});
