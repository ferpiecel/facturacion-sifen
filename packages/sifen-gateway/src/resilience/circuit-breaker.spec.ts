import { describe, expect, it } from 'vitest';
import { CircuitBreaker } from './circuit-breaker.ts';

function clock(start = 0) {
  let t = start;
  return { now: () => new Date(t), advance: (ms: number) => (t += ms) };
}

const options = { failureThreshold: 3, baseOpenMs: 1_000, maxOpenMs: 4_000 };

describe('CircuitBreaker', () => {
  it('stays closed below the failure threshold and a success resets the count', () => {
    const c = clock();
    const breaker = new CircuitBreaker({ ...options, now: c.now });
    breaker.failure();
    breaker.failure();
    breaker.success();
    breaker.failure();
    breaker.failure();
    expect(breaker.state).toBe('closed');
    expect(breaker.acquire()).toMatchObject({ allowed: true });
  });

  it('opens at the threshold and refuses calls until the cool-down elapses', () => {
    const c = clock();
    const breaker = new CircuitBreaker({ ...options, now: c.now });
    for (let i = 0; i < 3; i += 1) breaker.failure();
    expect(breaker.state).toBe('open');
    expect(breaker.acquire()).toEqual({ allowed: false, retryAt: new Date(1_000) });
    c.advance(999);
    expect(breaker.acquire().allowed).toBe(false);
  });

  it('lets exactly one probe through once the cool-down elapsed (half-open)', () => {
    const c = clock();
    const breaker = new CircuitBreaker({ ...options, now: c.now });
    for (let i = 0; i < 3; i += 1) breaker.failure();
    c.advance(1_000);
    expect(breaker.acquire()).toMatchObject({ allowed: true });
    expect(breaker.state).toBe('half-open');
    expect(breaker.acquire().allowed).toBe(false);
  });

  it('closes again when the probe succeeds', () => {
    const c = clock();
    const breaker = new CircuitBreaker({ ...options, now: c.now });
    for (let i = 0; i < 3; i += 1) breaker.failure();
    c.advance(1_000);
    breaker.acquire();
    breaker.success();
    expect(breaker.state).toBe('closed');
    expect(breaker.acquire()).toMatchObject({ allowed: true });
  });

  it('doubles the cool-down on each failed probe up to the cap', () => {
    const c = clock();
    const breaker = new CircuitBreaker({ ...options, now: c.now });
    for (let i = 0; i < 3; i += 1) breaker.failure();
    const waits: number[] = [];
    for (let trip = 0; trip < 4; trip += 1) {
      const refused = breaker.acquire();
      if (refused.allowed) throw new Error('expected a refusal');
      const wait = refused.retryAt.getTime() - c.now().getTime();
      waits.push(wait);
      c.advance(wait);
      breaker.acquire();
      breaker.failure();
    }
    expect(waits).toEqual([1_000, 2_000, 4_000, 4_000]);
  });

  it('resets the cool-down after a recovery', () => {
    const c = clock();
    const breaker = new CircuitBreaker({ ...options, now: c.now });
    for (let i = 0; i < 3; i += 1) breaker.failure();
    c.advance(1_000);
    breaker.acquire();
    breaker.failure();
    c.advance(2_000);
    breaker.acquire();
    breaker.success();
    for (let i = 0; i < 3; i += 1) breaker.failure();
    expect(breaker.acquire()).toEqual({
      allowed: false,
      retryAt: new Date(c.now().getTime() + 1_000),
    });
  });

  it('reports every transition', () => {
    const c = clock();
    const seen: string[] = [];
    const breaker = new CircuitBreaker({
      ...options,
      now: c.now,
      onStateChange: (from, to) => seen.push(`${from}>${to}`),
    });
    for (let i = 0; i < 3; i += 1) breaker.failure();
    c.advance(1_000);
    breaker.acquire();
    breaker.success();
    expect(seen).toEqual(['closed>open', 'open>half-open', 'half-open>closed']);
  });

  it.each([
    { failureThreshold: 0 },
    { baseOpenMs: 0 },
    { baseOpenMs: 5_000, maxOpenMs: 1_000 },
    { maxOpenMs: 73 * 60 * 60_000 },
    { maxOpenMs: 72 * 60 * 60_000 },
    { maxOpenMs: Number.POSITIVE_INFINITY },
    { maxOpenMs: Number.NaN },
    { baseOpenMs: Number.NaN },
    { probeTimeoutMs: 0 },
    { probeTimeoutMs: Number.POSITIVE_INFINITY },
  ])('rejects an invalid configuration %j', (override) => {
    expect(() => new CircuitBreaker({ ...options, ...override })).toThrow(RangeError);
  });

  describe('peek', () => {
    it('is null while closed and never changes the state', () => {
      const c = clock();
      const breaker = new CircuitBreaker({ ...options, now: c.now });
      expect(breaker.peek()).toBeNull();
      for (let i = 0; i < 3; i += 1) breaker.failure();
      expect(breaker.peek()).toEqual(new Date(1_000));
      c.advance(1_000);
      expect(breaker.peek()).toBeNull();
      expect(breaker.state).toBe('open');
    });

    it('keeps refusing while a probe is in flight', () => {
      const c = clock();
      const breaker = new CircuitBreaker({ ...options, probeTimeoutMs: 5_000, now: c.now });
      for (let i = 0; i < 3; i += 1) breaker.failure();
      c.advance(1_000);
      breaker.acquire();
      expect(breaker.peek()).toEqual(new Date(1_000 + 5_000));
    });
  });

  describe('half-open probe', () => {
    const probeOptions = { ...options, probeTimeoutMs: 5_000 };

    it('refuses with a retryAt in the future while the probe is in flight', () => {
      const c = clock();
      const breaker = new CircuitBreaker({ ...probeOptions, now: c.now });
      for (let i = 0; i < 3; i += 1) breaker.failure();
      c.advance(1_000);
      breaker.acquire();
      expect(breaker.acquire()).toEqual({ allowed: false, retryAt: new Date(1_000 + 5_000) });
    });

    it('reopens with a doubled cool-down when the probe is never settled', () => {
      const c = clock();
      const breaker = new CircuitBreaker({ ...probeOptions, now: c.now });
      for (let i = 0; i < 3; i += 1) breaker.failure();
      c.advance(1_000);
      breaker.acquire();
      c.advance(5_000);
      expect(breaker.acquire()).toEqual({ allowed: false, retryAt: new Date(6_000 + 2_000) });
      expect(breaker.state).toBe('open');
      c.advance(2_000);
      expect(breaker.acquire()).toMatchObject({ allowed: true });
    });

    it('ignores the outcome of a call that started before the circuit opened', () => {
      const c = clock();
      const breaker = new CircuitBreaker({ ...probeOptions, now: c.now });
      const straggler = breaker.acquire();
      if (!straggler.allowed) throw new Error('expected a closed circuit to allow');
      for (let i = 0; i < 3; i += 1) breaker.failure();
      breaker.success(straggler.token);
      expect(breaker.state).toBe('open');
      c.advance(1_000);
      const probe = breaker.acquire();
      if (!probe.allowed) throw new Error('expected a probe');
      breaker.success(straggler.token);
      expect(breaker.state).toBe('half-open');
      breaker.failure(straggler.token);
      expect(breaker.state).toBe('half-open');
      breaker.success(probe.token);
      expect(breaker.state).toBe('closed');
    });

    it('keeps working when onStateChange throws', () => {
      const c = clock();
      const breaker = new CircuitBreaker({
        ...probeOptions,
        now: c.now,
        onStateChange: () => {
          throw new Error('boom');
        },
      });
      for (let i = 0; i < 3; i += 1) breaker.failure();
      c.advance(1_000);
      const probe = breaker.acquire();
      expect(probe).toMatchObject({ allowed: true });
      expect(breaker.state).toBe('half-open');
      breaker.failure();
      expect(breaker.state).toBe('open');
    });
  });
});
