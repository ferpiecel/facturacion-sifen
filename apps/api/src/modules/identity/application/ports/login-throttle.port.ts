export interface ThrottleLimit {
  /** Attempts allowed inside one window; reaching it locks the subject. */
  max: number;
  windowSeconds: number;
  lockSeconds: number;
}

/**
 * Attempt counters (HU-E1-07 S4). A `subject` is a namespaced string such as `account:<email>`; adapters
 * store only its HMAC under a secret pepper, so unknown emails are throttled like real ones and nothing
 * identifying is stored in the clear.
 */
export interface LoginThrottle {
  /**
   * Reserves one attempt atomically BEFORE it is verified: true means the caller may verify (at most `max`
   * attempts per window get true, even under concurrency), false means the subject is locked and the attempt
   * must be refused without verifying.
   */
  reserve(subject: string, limit: ThrottleLimit): Promise<boolean>;
  /** A success: forgets the subject's attempts and unlocks it. */
  clear(subject: string): Promise<void>;
}
