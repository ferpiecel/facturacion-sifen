import { assertValidTenantId, type Database } from '@sifen/db';
import { EnvelopeCipher } from '../modules/custody/application/envelope-cipher.js';
import { WebhookSecretVault } from '../modules/custody/application/webhook-secret-vault.js';
import { createLocalKms } from '../modules/custody/infrastructure/adapters/local-kms.adapter.js';
import type { WebhookHttpPort } from '../modules/webhooks/application/ports/webhook-http.port.js';
import {
  WebhookDispatcher,
  type DispatchSummary,
} from '../modules/webhooks/application/webhook-dispatcher.js';
import { createDrizzleWebhookDeliveryStore } from '../modules/webhooks/infrastructure/drizzle-webhook-delivery-store.js';
import { SafeWebhookHttp } from '../modules/webhooks/infrastructure/safe-webhook-http.js';

/**
 * Webhook delivery job wiring (HU-E11-01, plan §10 queue `webhook-delivery`). Deliberately free of
 * `bullmq`: the transmission worker (HU-E6-02 worker PRs) owns the Worker/Queue bootstrap, and plugs
 * this in with
 *
 *   new Worker(WEBHOOK_DELIVERY_QUEUE, createWebhookDeliveryProcessor({ db, ...createWebhookDeliveryDeps(process.env) }))
 *   const { name, data, opts } = webhookDeliveryJob(tenantId); queue.add(name, data, opts)
 *
 * once per tenant (the repeatable job is idempotent through its `jobId`).
 */
export const WEBHOOK_DELIVERY_QUEUE = 'webhook-delivery';
const JOB_NAME = 'dispatch';
const DEFAULT_EVERY_MS = 30_000;

export interface WebhookDeliveryJobData {
  readonly tenantId: string;
}

/** Repeatable per-tenant job; the `jobId` keeps re-registering it at every boot from duplicating it. */
export function webhookDeliveryJob(tenantId: string, everyMs = DEFAULT_EVERY_MS) {
  return {
    name: JOB_NAME,
    data: { tenantId } satisfies WebhookDeliveryJobData,
    opts: {
      repeat: { every: everyMs },
      jobId: `webhook-delivery:${tenantId}`,
      removeOnComplete: true,
      removeOnFail: 100,
    },
  };
}

/**
 * The vault from `KMS_LOCAL_MASTER_KEY` (fails closed outside development and test, like the API)
 * and the SSRF-safe transport with its default limits only: no resolver, policy, CA or request override.
 */
export function createWebhookDeliveryDeps(env: {
  readonly KMS_LOCAL_MASTER_KEY?: string;
  readonly NODE_ENV?: string;
}): { vault: WebhookSecretVault; http: WebhookHttpPort } {
  const kms = createLocalKms(env.KMS_LOCAL_MASTER_KEY, env.NODE_ENV);
  return { vault: new WebhookSecretVault(new EnvelopeCipher(kms)), http: new SafeWebhookHttp() };
}

export interface WebhookDeliveryProcessorDeps {
  readonly db: Database;
  readonly vault: WebhookSecretVault;
  readonly http: WebhookHttpPort;
  readonly now?: () => Date;
  readonly random?: () => number;
  readonly batchSize?: number;
}

/** Runs one dispatch pass for the job's tenant. The tenant id is validated before any query is built. */
export function createWebhookDeliveryProcessor(deps: WebhookDeliveryProcessorDeps) {
  return async (job: { data: WebhookDeliveryJobData }): Promise<DispatchSummary> => {
    const { tenantId } = job.data;
    assertValidTenantId(tenantId);
    const dispatcher = new WebhookDispatcher({
      store: createDrizzleWebhookDeliveryStore({ db: deps.db, tenantId }),
      http: deps.http,
      vault: deps.vault,
      now: deps.now,
      random: deps.random,
      batchSize: deps.batchSize,
    });
    return dispatcher.runOnce();
  };
}
