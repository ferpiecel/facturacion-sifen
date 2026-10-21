export interface DueDocumentEmail {
  readonly id: string;
  readonly tenantId: string;
  readonly documentId: string;
  readonly recipient: string;
  /** Attempts already made before this claim. */
  readonly attemptCount: number;
  readonly tenantName: string;
}

export interface EmailAttemptOutcome {
  readonly status: 'sent' | 'failed' | 'dead';
  /** The attempt this outcome records, i.e. the claimed `attemptCount` + 1. */
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
  /** Due rows (`pending`/`failed`), each leased for `leaseMs` so a crash makes it due again. */
  claimDue(now: Date, limit: number, leaseMs: number): Promise<readonly DueDocumentEmail[]>;
  /** Stores the outcome; rejects when the row is no longer at the claimed attempt. */
  record(id: string, outcome: EmailAttemptOutcome): Promise<void>;
}
