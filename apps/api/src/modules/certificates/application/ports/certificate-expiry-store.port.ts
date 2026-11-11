export interface ActiveCertificate {
  readonly id: string;
  readonly environment: string;
  readonly fingerprint: string;
  readonly notAfter: Date;
}

export interface CertificateExpiryAlert {
  readonly certificateId: string;
  readonly environment: string;
  readonly fingerprint: string;
  readonly notAfter: Date;
  readonly thresholdDays: number;
  readonly daysRemaining: number;
}

/** One tenant's active certificate for its own environment, and the outbox the alerts go to. */
export interface CertificateExpiryStore {
  findActive(): Promise<readonly ActiveCertificate[]>;
  /** Idempotent: an alert already enqueued for the same certificate and threshold is not repeated. */
  enqueue(alerts: readonly CertificateExpiryAlert[], at: Date): Promise<void>;
}
