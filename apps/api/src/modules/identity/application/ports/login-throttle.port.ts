export interface ThrottleLimit {
  /** Failures inside one window that lock the subject. */
  max: number;
  windowSeconds: number;
  lockSeconds: number;
}

/**
 * Failed-attempt counters (HU-E1-07 S4). A `subject` is a namespaced string such as `account:<email>`;
 * adapters store only its SHA-256, so unknown emails are throttled like real ones and nothing is leaked.
 */
export interface LoginThrottle {
  isLocked(subject: string): Promise<boolean>;
  /** Counts one failure atomically; true when the subject is now locked. */
  recordFailure(subject: string, limit: ThrottleLimit): Promise<boolean>;
  clear(subject: string): Promise<void>;
}
