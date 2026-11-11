export interface PendingDocument {
  readonly id: string;
  readonly cdc: string;
  readonly signedAt: Date;
}

export interface DeadlineWarning {
  readonly documentId: string;
  readonly cdc: string;
  readonly thresholdHours: number;
  readonly deadline: Date;
  readonly hoursRemaining: number;
}

/** One tenant's documents still waiting for SIFEN, and the outbox the warnings go to. */
export interface DeadlineWarningStore {
  /** Signed, queued or submitted documents signed after `after` and up to `until` (inclusive). */
  findPending(range: { after: Date; until: Date }): Promise<readonly PendingDocument[]>;
  /** Idempotent: a warning already enqueued for the same document and threshold is not repeated. */
  enqueue(warnings: readonly DeadlineWarning[], at: Date): Promise<void>;
}
