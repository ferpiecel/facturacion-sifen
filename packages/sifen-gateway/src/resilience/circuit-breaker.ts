export type CircuitState = 'closed' | 'open' | 'half-open';

export interface CircuitBreakerOptions {
  /** Consecutive failures that open the circuit (default 5). */
  readonly failureThreshold?: number;
  /** First cool-down once open; it doubles on each failed probe (default 30 s). */
  readonly baseOpenMs?: number;
  /** Cap of the cool-down (default 15 min); never beyond the 72 h transmission window (ADR-0008). */
  readonly maxOpenMs?: number;
  readonly now?: () => Date;
  readonly onStateChange?: (from: CircuitState, to: CircuitState) => void;
}

export type Acquisition =
  { readonly allowed: true } | { readonly allowed: false; readonly retryAt: Date };

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
  private readonly failureThreshold: number;
  private readonly baseOpenMs: number;
  private readonly maxOpenMs: number;
  private readonly clock: () => Date;
  private readonly onStateChange: ((from: CircuitState, to: CircuitState) => void) | undefined;

  constructor(options: CircuitBreakerOptions = {}) {
    this.failureThreshold = options.failureThreshold ?? 5;
    this.baseOpenMs = options.baseOpenMs ?? 30_000;
    this.maxOpenMs = options.maxOpenMs ?? 15 * 60_000;
    this.clock = options.now ?? (() => new Date());
    this.onStateChange = options.onStateChange;
    if (!Number.isInteger(this.failureThreshold) || this.failureThreshold < 1) {
      throw new RangeError('failureThreshold must be a positive integer');
    }
    if (!(this.baseOpenMs > 0)) throw new RangeError('baseOpenMs must be positive');
    if (this.maxOpenMs < this.baseOpenMs || this.maxOpenMs > MAX_ALLOWED_OPEN_MS) {
      throw new RangeError('maxOpenMs must be between baseOpenMs and 72 h');
    }
  }

  get state(): CircuitState {
    return this.current;
  }

  /** Asks to make a call. An allowed half-open probe must be settled with `success` or `failure`. */
  acquire(): Acquisition {
    if (this.current === 'closed') return { allowed: true };
    if (this.current === 'half-open') return { allowed: false, retryAt: this.openUntil };
    if (this.clock() < this.openUntil) return { allowed: false, retryAt: this.openUntil };
    this.transition('half-open');
    return { allowed: true };
  }

  /**
   * When calls are currently refused, the instant they may resume; null when a call would be let
   * through. Read-only: unlike `acquire` it never consumes the half-open probe.
   */
  peek(): Date | null {
    if (this.current === 'closed') return null;
    if (this.current === 'open' && this.clock() >= this.openUntil) return null;
    return this.openUntil;
  }

  success(): void {
    this.failures = 0;
    this.trips = 0;
    if (this.current !== 'closed') this.transition('closed');
  }

  failure(): void {
    if (this.current === 'open') return;
    this.failures += 1;
    if (this.current === 'half-open' || this.failures >= this.failureThreshold) this.open();
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
    this.onStateChange?.(from, to);
  }
}
