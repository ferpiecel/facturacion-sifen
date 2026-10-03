import type { SealedSecret } from '../../../custody/domain/sealed-secret.js';

/** A claimed delivery with what is needed to sign and send it. */
export interface DueWebhookDelivery {
  readonly id: string;
  readonly tenantId: string;
  readonly endpointId: string;
  readonly url: string;
  /** The frozen event envelope. */
  readonly payload: Readonly<Record<string, unknown>>;
  readonly attemptCount: number;
  readonly firstAttemptAt: Date | null;
  readonly secret: {
    readonly version: number;
    readonly sealed: SealedSecret;
    readonly previousSealed: SealedSecret | null;
    readonly previousExpiresAt: Date | null;
  };
}

/** The row state after an attempt. `nextAttemptAt` is set exactly while the status is `failed`. */
export interface WebhookAttemptOutcome {
  readonly status: 'delivered' | 'failed' | 'dead';
  readonly attemptCount: number;
  readonly firstAttemptAt: Date;
  readonly lastAttemptAt: Date;
  readonly nextAttemptAt: Date | null;
  readonly deliveredAt: Date | null;
  readonly lastStatusCode: number | null;
  /** A classified code or `HTTP <status>`; never response data. */
  readonly lastError: string | null;
}

/** Delivery queue of one tenant (bound when the store is created, like the other tenant stores). */
export interface WebhookDeliveryStore {
  /**
   * Takes up to `limit` deliveries that are pending or failed, due at `now` and whose endpoint is
   * active, and pushes their `next_attempt_at` out by `leaseMs` so a concurrent worker (or a crash
   * before `record`) does not send them twice at once.
   */
  claimDue(now: Date, limit: number, leaseMs: number): Promise<DueWebhookDelivery[]>;
  /**
   * Stores the outcome only while the delivery is still pending or failed at attempt
   * `outcome.attemptCount - 1` (the one that was claimed).
   *
   * @throws when it no longer is, e.g. a newer worker already recorded after this lease expired.
   */
  record(deliveryId: string, outcome: WebhookAttemptOutcome): Promise<void>;
}
