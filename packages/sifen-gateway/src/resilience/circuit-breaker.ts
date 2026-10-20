export type CircuitState = 'closed' | 'open' | 'half-open';

export interface CircuitBreakerOptions {
  /** Consecutive failures that open the circuit (default 5). */
  readonly failureThreshold?: number;
  /** First cool-down once open; it doubles on each failed probe (default 30 s). */
  readonly baseOpenMs?: number;
  /** Cap of the cool-down (default 15 min); never beyond the 72 h transmission window (ADR-0008). */
  readonly maxOpenMs?: number;
  /** How long a half-open probe may stay unsettled before it counts as failed (default 60 s). */
  readonly probeTimeoutMs?: number;
  readonly now?: () => Date;
  readonly onStateChange?: (from: CircuitState, to: CircuitState) => void;
}

export type Acquisition =
  | { readonly allowed: true; readonly token: number }
  | { readonly allowed: false; readonly retryAt: Date };

/** Exclusive: the cool-down must stay below the 72 h transmission window. */
const MAX_ALLOWED_OPEN_MS = 72 * 60 * 60_000;

/**
 * Circuit breaker of one SIFEN endpoint. Closed: calls flow and consecutive failures are counted.
 * Open: calls are refused until the cool-down passes, then exactly one probe is let through
 * (half-open); its success closes the circuit, its failure reopens it with a doubled cool-down.
 * Not thread-safe across processes: each worker keeps its own view of the endpoint.
 */
export class CircuitBreaker {
  private current: CircuitState = 'closed';
  private failures = 0;
  private trips = 0;
  private openUntil = new Date(0);
  private probeDeadline = new Date(0);
  /** Bumped on every transition so a call settled after its circuit moved on is recognised. */
  private generation = 0;
  private readonly failureThreshold: number;
  private readonly baseOpenMs: number;
  private readonly maxOpenMs: number;
  private readonly probeTimeoutMs: number;
  private readonly clock: () => Date;
  private readonly onStateChange: ((from: CircuitState, to: CircuitState) => void) | undefined;

  constructor(options: CircuitBreakerOptions = {}) {
    this.failureThreshold = options.failureThreshold ?? 5;
    this.baseOpenMs = options.baseOpenMs ?? 30_000;
    this.maxOpenMs = options.maxOpenMs ?? 15 * 60_000;
    this.probeTimeoutMs = options.probeTimeoutMs ?? 60_000;
    this.clock = options.now ?? (() => new Date());
    this.onStateChange = options.onStateChange;
    if (!Number.isInteger(this.failureThreshold) || this.failureThreshold < 1) {
      throw new RangeError('failureThreshold must be a positive integer');
    }
    if (!Number.isFinite(this.baseOpenMs) || !(this.baseOpenMs > 0)) {
      throw new RangeError('baseOpenMs must be positive and finite');
    }
    if (
      !Number.isFinite(this.maxOpenMs) ||
      this.maxOpenMs < this.baseOpenMs ||
      this.maxOpenMs >= MAX_ALLOWED_OPEN_MS
    ) {
      throw new RangeError('maxOpenMs must be between baseOpenMs and 72 h (exclusive)');
    }
    if (!Number.isFinite(this.probeTimeoutMs) || !(this.probeTimeoutMs > 0)) {
      throw new RangeError('probeTimeoutMs must be positive and finite');
    }
  }

  get state(): CircuitState {
    return this.current;
  }

  /**
   * Asks to make a call. Pass the returned `token` to `success` / `failure` so the outcome of a call
   * that started before the circuit changed state is ignored. A half-open probe that is never
   * settled counts as failed after `probeTimeoutMs`.
   */
  acquire(): Acquisition {
    this.expireProbe();
    if (this.current === 'closed') return { allowed: true, token: this.generation };
    if (this.current === 'half-open') return { allowed: false, retryAt: this.probeDeadline };
    if (this.clock() < this.openUntil) return { allowed: false, retryAt: this.openUntil };
    this.transition('half-open');
    this.probeDeadline = new Date(this.clock().getTime() + this.probeTimeoutMs);
    return { allowed: true, token: this.generation };
  }

  /**
   * When calls are currently refused, the instant they may resume; null when a call would be let
   * through. It never consumes the half-open probe (it only reaps an expired one).
   */
  peek(): Date | null {
    this.expireProbe();
    if (this.current === 'closed') return null;
    if (this.current === 'half-open') return this.probeDeadline;
    return this.clock() >= this.openUntil ? null : this.openUntil;
  }

  success(token?: number): void {
    if (token !== undefined && token !== this.generation) return;
    this.failures = 0;
    this.trips = 0;
    if (this.current !== 'closed') this.transition('closed');
  }

  failure(token?: number): void {
    if (token !== undefined && token !== this.generation) return;
    if (this.current === 'open') return;
    this.failures += 1;
    if (this.current === 'half-open' || this.failures >= this.failureThreshold) this.open();
  }

  private expireProbe(): void {
    if (this.current === 'half-open' && this.clock() >= this.probeDeadline) this.open();
  }

  private open(): void {
    this.trips += 1;
    const wait = Math.min(this.baseOpenMs * 2 ** (this.trips - 1), this.maxOpenMs);
    this.openUntil = new Date(this.clock().getTime() + wait);
    this.failures = 0;
    this.transition('open');
  }

  private transition(to: CircuitState): void {
    const from = this.current;
    this.current = to;
    this.generation += 1;
    try {
      this.onStateChange?.(from, to);
    } catch {
      // An observer must never strand the breaker (a half-open probe would never be settled).
    }
  }
}
