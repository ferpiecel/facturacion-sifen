import { eq } from 'drizzle-orm';
import {
  auditLog,
  createPgliteDatabase,
  tenants,
  webhookDeliveries,
  webhookEndpoints,
  withTenantTransaction,
  type DatabaseHandle,
} from '@sifen/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDrizzleWebhookDeliveryAdminStore } from './drizzle-webhook-delivery-admin-store.js';

const ACTOR = { type: 'api_key', id: 'key-1' } as const;
const SEALED = {
  v: 1,
  keyId: 'k',
  wrappedKey: 'AA==',
  nonce: 'AA==',
  tag: 'AA==',
  ciphertext: 'AA==',
};
const T0 = new Date('2026-10-01T12:00:00.000Z');
const AT = new Date('2026-10-02T00:00:00.000Z');

/** Spec: HU-E11-01 (S5). Delivery history and replay as app_user under RLS. */
describe('DrizzleWebhookDeliveryAdminStore', () => {
  let handle: DatabaseHandle;
  let tenantId: string;
  let otherTenantId: string;
  let ep1: string;
  let ep2: string;
  let n = 0;

  beforeEach(async () => {
    handle = createPgliteDatabase();
    await handle.migrate();
    const [a, b] = await handle.db
      .insert(tenants)
      .values([{ name: 'A' }, { name: 'B' }])
      .returning();
    [tenantId, otherTenantId] = [a.id, b.id];
    ep1 = await endpoint(tenantId);
    ep2 = await endpoint(tenantId);
  });
  afterEach(async () => {
    await handle.close();
  });

  const store = () => createDrizzleWebhookDeliveryAdminStore(handle.db);
  async function endpoint(tenant: string) {
    return (
      await handle.db
        .insert(webhookEndpoints)
        .values({ tenantId: tenant, url: 'https://h.example.com/x', sealed: SEALED })
        .returning()
    )[0].id;
  }
  async function delivery(
    over: Partial<typeof webhookDeliveries.$inferInsert> = {},
    tenant = tenantId,
    ep = ep1,
  ) {
    n += 1;
    return (
      await handle.db
        .insert(webhookDeliveries)
        .values({
          tenantId: tenant,
          endpointId: ep,
          eventId: `evt_${String(n).padStart(8, '0')}`,
          eventType: 'document.approved',
          payload: { data: { secret: 'x' } },
          nextAttemptAt: T0,
          createdAt: new Date(T0.getTime() + n * 1000),
          ...over,
        })
        .returning()
    )[0].id;
  }

  it('lists newest first with filters, never exposing the payload', async () => {
    const a = await delivery();
    const b = await delivery(
      {
        status: 'dead',
        nextAttemptAt: null,
        attemptCount: 4,
        lastStatusCode: 503,
        lastError: 'HTTP 503',
      },
      tenantId,
      ep2,
    );
    await delivery({}, otherTenantId, await endpoint(otherTenantId));
    const all = await store().list(tenantId, { limit: 10 });
    expect(all.map((d) => d.id)).toEqual([b, a]);
    expect(all[0]).toMatchObject({
      endpointId: ep2,
      status: 'dead',
      attemptCount: 4,
      lastStatusCode: 503,
      lastError: 'HTTP 503',
    });
    expect(Object.keys(all[0])).not.toContain('payload');
    expect((await store().list(tenantId, { limit: 10, endpointId: ep1 })).map((d) => d.id)).toEqual(
      [a],
    );
    expect((await store().list(tenantId, { limit: 10, status: 'dead' })).map((d) => d.id)).toEqual([
      b,
    ]);
  });

  it('pages by keyset, one extra row signalling a next page', async () => {
    const ids = [await delivery(), await delivery(), await delivery()];
    const first = await store().list(tenantId, { limit: 2 });
    expect(first.map((d) => d.id)).toEqual([ids[2], ids[1], ids[0]]);
    const after = { createdAt: first[1].createdAt, id: first[1].id };
    expect((await store().list(tenantId, { limit: 2, after })).map((d) => d.id)).toEqual([ids[0]]);
  });

  it('replays a dead delivery to pending, due now, keeping attempt_count, and audits it', async () => {
    const id = await delivery({
      status: 'dead',
      nextAttemptAt: null,
      attemptCount: 14,
      lastStatusCode: 500,
    });
    const view = await store().replay(tenantId, ACTOR, id, AT);
    expect(view).toMatchObject({ id, status: 'pending', attemptCount: 14, nextAttemptAt: AT });
    const [row] = await handle.db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.id, id));
    expect(row).toMatchObject({ status: 'pending', attemptCount: 14 });
    const [entry] = await withTenantTransaction(handle.db, tenantId, (tx) =>
      tx.select().from(auditLog),
    );
    expect(entry).toMatchObject({ action: 'webhook_delivery.replay', entityId: id });
  });

  it('refuses to replay anything that is not dead, and unknown or foreign deliveries', async () => {
    const pending = await delivery();
    const dead = await delivery({ status: 'dead', nextAttemptAt: null }, tenantId, ep2);
    expect(await store().replay(tenantId, ACTOR, pending, AT)).toBe('not-dead');
    expect(await store().replay(otherTenantId, ACTOR, dead, AT)).toBeNull();
    expect(
      await store().replay(tenantId, ACTOR, '00000000-0000-4000-8000-000000000000', AT),
    ).toBeNull();
  });

  it('refuses to replay a dead delivery whose endpoint is inactive, and keeps it dead', async () => {
    const id = await delivery({ status: 'dead', nextAttemptAt: null }, tenantId, ep2);
    await handle.db
      .update(webhookEndpoints)
      .set({ active: false })
      .where(eq(webhookEndpoints.id, ep2));
    expect(await store().replay(tenantId, ACTOR, id, AT)).toBe('endpoint-inactive');
    const [row] = await handle.db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.id, id));
    expect(row.status).toBe('dead');
  });
});
