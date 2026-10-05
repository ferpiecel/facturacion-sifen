import type { WebhookSecretVault } from '../../custody/application/webhook-secret-vault.js';
import { nextRetryAt } from '../domain/webhook-backoff.js';
import type { WebhookEvent } from '../domain/webhook-event.js';
import { serializeWebhookEvent } from '../domain/webhook-event.js';
import { SIGNATURE_HEADER, signWebhook } from '../domain/webhook-signature.js';
import type {
  DueWebhookDelivery,
  WebhookAttemptOutcome,
  WebhookDeliveryStore,
} from './ports/webhook-delivery-store.port.js';
import type { WebhookHttpPort, WebhookHttpResult } from './ports/webhook-http.port.js';

/** A claim holds a delivery this long; a crash before `record` makes it due again afterwards. */
const LEASE_MS = 2 * 60 * 1000;
const DEFAULT_BATCH_SIZE = 25;
const USER_AGENT = 'Sifen-Webhooks/1';

export interface WebhookDispatcherDeps {
  readonly store: WebhookDeliveryStore;
  readonly http: WebhookHttpPort;
  readonly vault: Pick<WebhookSecretVault, 'signingSecrets'>;
  readonly now?: () => Date;
  readonly random?: () => number;
  readonly batchSize?: number;
}

export interface DispatchSummary {
  readonly claimed: number;
  readonly delivered: number;
  readonly retried: number;
  readonly dead: number;
  /** Attempts made whose result could not be stored; the lease makes them due again. */
  readonly unrecorded: number;
}

/**
 * Sends the due webhook deliveries of one tenant (HU-E11-01, ADR-0011): serializes the frozen payload,
 * signs it with a fresh timestamp for every attempt (both secrets while a rotation overlaps) and POSTs
 * it. A 2xx delivers; anything else counts an attempt and schedules the next one with the backoff, or
 * dead-letters the delivery once the 24 hour window is over. Only a classified code or `HTTP <status>`
 * is stored, never response data.
 */
export class WebhookDispatcher {
  private readonly now: () => Date;
  private readonly random: () => number;
  private readonly batchSize: number;

  constructor(private readonly deps: WebhookDispatcherDeps) {
    this.now = deps.now ?? (() => new Date());
    this.random = deps.random ?? Math.random;
    this.batchSize = deps.batchSize ?? DEFAULT_BATCH_SIZE;
  }

  async runOnce(): Promise<DispatchSummary> {
    const due = await this.deps.store.claimDue(this.now(), this.batchSize, LEASE_MS);
    const outcomes = await Promise.all(due.map((delivery) => this.attempt(delivery)));
    const count = (status: WebhookAttemptOutcome['status']) =>
      outcomes.filter((o) => o?.status === status).length;
    return {
      claimed: due.length,
      delivered: count('delivered'),
      retried: count('failed'),
      dead: count('dead'),
      unrecorded: outcomes.filter((o) => o === undefined).length,
    };
  }

  private async attempt(delivery: DueWebhookDelivery): Promise<WebhookAttemptOutcome | undefined> {
    const at = this.now();
    const result = await this.send(delivery, at);
    const attemptCount = delivery.attemptCount + 1;
    const firstAttemptAt = delivery.firstAttemptAt ?? at;
    const delivered = result.kind === 'response' && result.status >= 200 && result.status < 300;
    const next = delivered
      ? null
      : nextRetryAt({ firstAttemptAt, now: at, failedAttempts: attemptCount, random: this.random });
    const outcome: WebhookAttemptOutcome = {
      status: delivered ? 'delivered' : next === null ? 'dead' : 'failed',
      attemptCount,
      firstAttemptAt,
      lastAttemptAt: at,
      nextAttemptAt: next,
      deliveredAt: delivered ? at : null,
      lastStatusCode: result.kind === 'response' ? result.status : null,
      lastError: delivered
        ? null
        : result.kind === 'response'
          ? `HTTP ${String(result.status)}`
          : result.code,
    };
    try {
      await this.deps.store.record(delivery.id, outcome);
      return outcome;
    } catch {
      return undefined;
    }
  }

  private async send(delivery: DueWebhookDelivery, at: Date): Promise<WebhookHttpResult> {
    let secrets: string[];
    try {
      secrets = await this.deps.vault.signingSecrets({
        tenantId: delivery.tenantId,
        endpointId: delivery.endpointId,
        secretVersion: delivery.secret.version,
        sealed: delivery.secret.sealed,
        previousSealed: delivery.secret.previousSealed,
        previousExpiresAt: delivery.secret.previousExpiresAt,
        now: at,
      });
    } catch {
      return { kind: 'error', code: 'secret_unavailable' };
    }
    const body = serializeWebhookEvent(delivery.payload as unknown as WebhookEvent);
    const signature = signWebhook({
      secret: secrets,
      body,
      timestamp: Math.floor(at.getTime() / 1000),
    });
    try {
      return await this.deps.http.post({
        url: delivery.url,
        headers: {
          'content-type': 'application/json',
          'user-agent': USER_AGENT,
          [SIGNATURE_HEADER.toLowerCase()]: signature,
        },
        body,
      });
    } catch {
      return { kind: 'error', code: 'network_error' };
    }
  }
}
