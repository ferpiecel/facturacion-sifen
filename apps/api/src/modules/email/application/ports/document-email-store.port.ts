export interface DueDocumentEmail {
  readonly id: string;
  readonly tenantId: string;
  readonly documentId: string;
  readonly recipient: string;
  /** The attempt this claim starts (attempts made so far, this one included). */
  readonly attemptCount: number;
  readonly tenantName: string;
}

export interface EmailAttemptOutcome {
  readonly status: 'sent' | 'failed' | 'dead';
  /** The attempt this outcome records, i.e. the claimed `attemptCount`. */
  readonly attemptCount: number;
  readonly lastAttemptAt: Date;
  /** Set for `failed` only, null otherwise. */
  readonly nextAttemptAt: Date | null;
  readonly sentAt: Date | null;
  /** A classified code, never provider text. */
  readonly lastError: string | null;
}

/** The outbox of one tenant (HU-E11-02). */
export interface DocumentEmailStore {
  /**
   * Due rows (`pending`/`failed`), each counted as an attempt and leased for `leaseMs` so a crash
   * makes it due again. `leaseMs` must exceed the mailer timeout: a send that outlives its lease
   * can be claimed again, and only the latest claim's `record` is accepted.
   */
  claimDue(now: Date, limit: number, leaseMs: number): Promise<readonly DueDocumentEmail[]>;
  /** Stores the outcome; rejects when the row was claimed again since. */
  record(id: string, outcome: EmailAttemptOutcome): Promise<void>;
}
