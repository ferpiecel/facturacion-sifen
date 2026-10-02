import { eq } from 'drizzle-orm';
import {
  createPgliteDatabase,
  tenants,
  webhookDeliveries,
  webhookEndpoints,
  withTenantTransaction,
  type DatabaseHandle,
} from '@sifen/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDrizzleWebhookDeliveryStore } from './drizzle-webhook-delivery-store.js';

const NOW = new Date('2026-10-01T12:00:00.000Z');
const MIN = 60_000;
const SEALED = {
  v: 1,
  keyId: 'k',
  wrappedKey: 'AA==',
  nonce: 'AA==',
  tag: 'AA==',
  ciphertext: 'AA==',
};

/** Spec: HU-E11-01 (S3). WebhookDeliveryStore over `webhook_deliveries`, run as app_user under RLS. */
describe('DrizzleWebhookDeliveryStore', () => {
  let handle: DatabaseHandle;
  let tenantId: string;
  let otherTenantId: string;
  let endpointId: string;
  let n = 0;

  beforeEach(async () => {
    handle = createPgliteDatabase();
    await handle.migrate();
    const [a, b] = await handle.db
      .insert(tenants)
      .values([{ name: 'A' }, { name: 'B' }])
      .returning();
    [tenantId, otherTenantId] = [a.id, b.id];
    endpointId = await endpoint(tenantId);
  });

  afterEach(async () => {
    await handle.close();
  });

  const storeFor = (tenant: string) =>
    createDrizzleWebhookDeliveryStore({ db: handle.db, tenantId: tenant });
  async function endpoint(tenant: string, active = true): Promise<string> {
    const [row] = await handle.db
      .insert(webhookEndpoints)
      .values({ tenantId: tenant, url: 'https://hooks.example.com/x', sealed: SEALED, active })
      .returning();
    return row.id;
  }
  async function delivery(
    over: Partial<typeof webhookDeliveries.$inferInsert> = {},
    tenant = tenantId,
    ep = endpointId,
  ) {
    n += 1;
    const [row] = await handle.db
      .insert(webhookDeliveries)
      .values({
        tenantId: tenant,
        endpointId: ep,
        eventId: `evt_${String(n).padStart(8, '0')}`,
        eventType: 'document.approved',
        payload: { id: 'evt' },
        nextAttemptAt: new Date(NOW.getTime() - MIN),
        ...over,
      })
      .returning();
    return row.id;
  }
  const read = (id: string) =>
    withTenantTransaction(handle.db, tenantId, (tx) =>
      tx.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, id)),
    ).then((rows) => rows[0]);

  it('claims due deliveries oldest first with what is needed to sign them', async () => {
    const late = await delivery({ nextAttemptAt: new Date(NOW.getTime() - MIN) });
    const early = await delivery({
      nextAttemptAt: new Date(NOW.getTime() - 5 * MIN),
      status: 'failed',
      attemptCount: 2,
      firstAttemptAt: new Date(NOW.getTime() - 9 * MIN),
    });
    const claimed = await storeFor(tenantId).claimDue(NOW, 10, 2 * MIN);
    expect(claimed.map((d) => d.id)).toEqual([early, late]);
    expect(claimed[0]).toMatchObject({
      tenantId,
      endpointId,
      url: 'https://hooks.example.com/x',
      payload: { id: 'evt' },
      attemptCount: 2,
      firstAttemptAt: new Date(NOW.getTime() - 9 * MIN),
      secret: { version: 1, sealed: SEALED, previousSealed: null, previousExpiresAt: null },
    });
  });

  it('skips what is not due, delivered, dead, on an inactive endpoint or another tenant', async () => {
    await delivery({ nextAttemptAt: new Date(NOW.getTime() + MIN) });
    await delivery({ status: 'delivered', nextAttemptAt: null, deliveredAt: NOW });
    await delivery({ status: 'dead', nextAttemptAt: null });
    await delivery({}, tenantId, await endpoint(tenantId, false));
    await delivery({}, otherTenantId, await endpoint(otherTenantId));
    expect(await storeFor(tenantId).claimDue(NOW, 10, 2 * MIN)).toEqual([]);
  });

  it('is bounded and leases what it claims so it is not handed out twice', async () => {
    const ids = [await delivery(), await delivery(), await delivery()];
    const store = storeFor(tenantId);
    expect(await store.claimDue(NOW, 2, 2 * MIN)).toHaveLength(2);
    expect(await store.claimDue(NOW, 2, 2 * MIN)).toHaveLength(1);
    expect(await store.claimDue(NOW, 2, 2 * MIN)).toHaveLength(0);
    expect((await read(ids[0])).nextAttemptAt).toEqual(new Date(NOW.getTime() + 2 * MIN));
    expect(await store.claimDue(new Date(NOW.getTime() + 3 * MIN), 5, 2 * MIN)).toHaveLength(3);
  });

  it('records a delivered, a failed and a dead outcome', async () => {
    const store = storeFor(tenantId);
    const base = {
      attemptCount: 1,
      firstAttemptAt: NOW,
      lastAttemptAt: NOW,
      deliveredAt: null,
      lastStatusCode: null,
      lastError: null,
    };
    const ok = await delivery();
    await store.record(ok, {
      ...base,
      status: 'delivered',
      nextAttemptAt: null,
      deliveredAt: NOW,
      lastStatusCode: 204,
    });
    expect(await read(ok)).toMatchObject({
      status: 'delivered',
      attemptCount: 1,
      deliveredAt: NOW,
      lastStatusCode: 204,
      nextAttemptAt: null,
    });
    const retry = await delivery();
    const next = new Date(NOW.getTime() + MIN);
    await store.record(retry, {
      ...base,
      status: 'failed',
      nextAttemptAt: next,
      lastStatusCode: 503,
      lastError: 'HTTP 503',
    });
    expect(await read(retry)).toMatchObject({
      status: 'failed',
      nextAttemptAt: next,
      lastError: 'HTTP 503',
      firstAttemptAt: NOW,
    });
    const dead = await delivery();
    await store.record(dead, {
      ...base,
      status: 'dead',
      nextAttemptAt: null,
      lastError: 'timeout',
    });
    expect(await read(dead)).toMatchObject({
      status: 'dead',
      nextAttemptAt: null,
      lastError: 'timeout',
    });
  });

  it('refuses to record over a delivery that is no longer pending or failed', async () => {
    const id = await delivery({ status: 'delivered', nextAttemptAt: null, deliveredAt: NOW });
    await expect(
      storeFor(tenantId).record(id, {
        status: 'failed',
        attemptCount: 1,
        firstAttemptAt: NOW,
        lastAttemptAt: NOW,
        nextAttemptAt: NOW,
        deliveredAt: null,
        lastStatusCode: 500,
        lastError: 'HTTP 500',
      }),
    ).rejects.toThrow(/not pending or failed/);
  });
});
