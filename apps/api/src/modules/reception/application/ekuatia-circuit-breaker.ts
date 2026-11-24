export type EkuatiaBreakerState = 'closed' | 'open' | 'half_open';

export interface EkuatiaCircuitBreakerOptions {
  /** Consecutive failures that open the breaker. */
  readonly failureThreshold: number;
  /** How long it stays open before one probe call is allowed. */
  readonly cooldownMs: number;
  readonly now: () => Date;
}

/**
 * Circuit breaker around the solver and the eKuatia site (reception R6.3, ADR-0027 point 4). While
 * it is open no captcha is solved, so a broken site or an empty provider balance stops costing
 * money. After the cooldown exactly one probe call goes through (half open): success closes it,
 * failure reopens it for a full cooldown. State lives in the process: each worker has its own.
 */
export class EkuatiaCircuitBreaker {
  private failures = 0;
  private openedAt: number | null = null;
  private probing = false;

  constructor(private readonly options: EkuatiaCircuitBreakerOptions) {
    const { failureThreshold, cooldownMs } = options;
    if (!Number.isInteger(failureThreshold) || failureThreshold < 1) {
      throw new RangeError('failureThreshold must be a positive integer');
    }
    if (!Number.isFinite(cooldownMs) || cooldownMs <= 0) {
      throw new RangeError('cooldownMs must be a positive finite number');
    }
  }

  state(): EkuatiaBreakerState {
    if (this.openedAt === null) return 'closed';
    return this.cooledDown() ? 'half_open' : 'open';
  }

  /**
   * True when a call may go ahead. In half-open state only the first caller gets true; it must then
   * report the outcome with `recordSuccess`, `recordFailure`, `recordFatal` or `releaseProbe`.
   */
  tryAcquire(): boolean {
    if (this.openedAt === null) return true;
    if (!this.cooledDown() || this.probing) return false;
    this.probing = true;
    return true;
  }

  recordSuccess(): void {
    this.failures = 0;
    this.openedAt = null;
    this.probing = false;
  }

  recordFailure(): void {
    const probe = this.probing;
    this.probing = false;
    this.failures += 1;
    if (probe || this.failures >= this.options.failureThreshold) this.open();
  }

  /** A failure retrying cannot fix (zero balance, bad key): opens at once. */
  recordFatal(): void {
    this.probing = false;
    this.open();
  }

  /** The probe ended without learning anything (e.g. aborted): let the next caller probe. */
  releaseProbe(): void {
    this.probing = false;
  }

  private open(): void {
    this.openedAt = this.options.now().getTime();
  }

  private cooledDown(): boolean {
    return (
      this.openedAt !== null &&
      this.options.now().getTime() - this.openedAt >= this.options.cooldownMs
    );
  }
}
