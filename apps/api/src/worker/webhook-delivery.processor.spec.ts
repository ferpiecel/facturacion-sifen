import { randomBytes, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import {
  createPgliteDatabase,
  InvalidTenantIdError,
  tenants,
  webhookDeliveries,
  webhookEndpoints,
  withTenantTransaction,
  type DatabaseHandle,
} from '@sifen/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { seedDocuments } from '../../test/support/document-seed.js';
import { WebhookSecretVault } from '../modules/custody/application/webhook-secret-vault.js';
import type { WebhookHttpPort } from '../modules/webhooks/application/ports/webhook-http.port.js';
import { verifyWebhookSignature } from '../modules/webhooks/domain/webhook-signature.js';
import { SafeWebhookHttp } from '../modules/webhooks/infrastructure/safe-webhook-http.js';
import { enqueueDocumentEvents } from '../modules/webhooks/infrastructure/enqueue-document-events.js';
import {
  WEBHOOK_DELIVERY_QUEUE,
  createWebhookDeliveryDeps,
  createWebhookDeliveryProcessor,
  webhookDeliveryJob,
} from './webhook-delivery.processor.js';

const SECRET = 'whsec_integration';

/** Spec: HU-E11-01 (S3 wiring). Outbox rows are delivered, signed, by the per-tenant job processor. */
describe('webhook delivery worker', () => {
  let handle: DatabaseHandle;
  let tenantId: string;
  let otherTenantId: string;
  let vault: WebhookSecretVault;

  beforeEach(async () => {
    handle = createPgliteDatabase();
    await handle.migrate();
    const [a, b] = await handle.db
      .insert(tenants)
      .values([{ name: 'A' }, { name: 'B' }])
      .returning();
    [tenantId, otherTenantId] = [a.id, b.id];
    const { vault: built } = createWebhookDeliveryDeps({
      KMS_LOCAL_MASTER_KEY: randomBytes(32).toString('base64'),
      NODE_ENV: 'production',
    });
    vault = built;
  });
  afterEach(async () => {
    await handle.close();
  });

  async function endpoint(tenant: string): Promise<string> {
    const id = randomUUID();
    const sealed = await vault.seal(SECRET, { tenantId: tenant, endpointId: id, version: 1 });
    await handle.db
      .insert(webhookEndpoints)
      .values({ id, tenantId: tenant, url: 'https://hooks.example.com/x', sealed });
    return id;
  }
  async function outbox(tenant: string): Promise<string> {
    const [doc] = await seedDocuments(handle.db, tenant, ['approved']);
    await withTenantTransaction(handle.db, tenant, (tx) =>
      enqueueDocumentEvents(tx, {
        tenantId: tenant,
        documentIds: [doc.id],
        at: new Date('2026-10-01T12:00:00Z'),
      }),
    );
    return doc.id;
  }
  const processor = (http: WebhookHttpPort) =>
    createWebhookDeliveryProcessor({
      db: handle.db,
      vault,
      http,
      now: () => new Date('2026-10-01T12:05:00Z'),
    });

  it('delivers the outbox rows of the job tenant, signed with its sealed secret', async () => {
    await endpoint(tenantId);
    await outbox(tenantId);
    const post = vi.fn<WebhookHttpPort['post']>(() =>
      Promise.resolve({ kind: 'response', status: 200 }),
    );
    expect(await processor({ post })({ data: { tenantId } })).toMatchObject({
      claimed: 1,
      delivered: 1,
    });
    const request = post.mock.calls[0][0];
    expect(
      verifyWebhookSignature({
        secret: SECRET,
        body: request.body,
        header: request.headers['sifen-signature'],
        now: Date.parse('2026-10-01T12:05:00Z') / 1000,
      }).ok,
    ).toBe(true);
    expect(JSON.parse(request.body)).toMatchObject({
      type: 'document.approved',
      tenant_id: tenantId,
    });
    const [row] = await handle.db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.tenantId, tenantId));
    expect(row).toMatchObject({ status: 'delivered', attemptCount: 1, lastStatusCode: 200 });
  });

  it('never touches another tenant', async () => {
    await endpoint(otherTenantId);
    await outbox(otherTenantId);
    const post = vi.fn<WebhookHttpPort['post']>(() =>
      Promise.resolve({ kind: 'response', status: 200 }),
    );
    expect(await processor({ post })({ data: { tenantId } })).toMatchObject({ claimed: 0 });
    expect(post).not.toHaveBeenCalled();
  });

  it('rejects a job without a valid tenant id before touching the database', async () => {
    const post = vi.fn<WebhookHttpPort['post']>();
    await expect(
      processor({ post })({ data: { tenantId: "x'; drop table" } }),
    ).rejects.toBeInstanceOf(InvalidTenantIdError);
    expect(post).not.toHaveBeenCalled();
  });

  it('builds the vault from KMS_LOCAL_MASTER_KEY and the transport with limits only', () => {
    const deps = createWebhookDeliveryDeps({
      KMS_LOCAL_MASTER_KEY: randomBytes(32).toString('base64'),
      NODE_ENV: 'production',
    });
    expect(deps.vault).toBeInstanceOf(WebhookSecretVault);
    expect(deps.http).toBeInstanceOf(SafeWebhookHttp);
    expect(() => createWebhookDeliveryDeps({ NODE_ENV: 'production' })).toThrow(
      /KMS_LOCAL_MASTER_KEY/,
    );
  });

  it('describes the repeatable per-tenant BullMQ job', () => {
    expect(WEBHOOK_DELIVERY_QUEUE).toBe('webhook-delivery');
    expect(webhookDeliveryJob(tenantId, 15_000)).toEqual({
      name: 'dispatch',
      data: { tenantId },
      opts: {
        repeat: { every: 15_000 },
        jobId: `webhook-delivery:${tenantId}`,
        removeOnComplete: true,
        removeOnFail: 100,
      },
    });
    expect(webhookDeliveryJob(tenantId).opts.repeat.every).toBe(30_000);
  });
});
