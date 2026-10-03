import { eq } from 'drizzle-orm';
import {
  auditLog,
  createPgliteDatabase,
  tenants,
  webhookEndpoints,
  withTenantTransaction,
  type DatabaseHandle,
} from '@sifen/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDrizzleWebhookEndpointStore } from './drizzle-webhook-endpoint-store.js';

const ACTOR = { type: 'api_key', id: 'key-1' } as const;
const SEALED = {
  v: 1,
  keyId: 'k',
  wrappedKey: 'AA==',
  nonce: 'AA==',
  tag: 'AA==',
  ciphertext: 'AA==',
};
const SEALED_2 = { ...SEALED, ciphertext: 'BB==' };
const DAY = 86_400_000;

/** Spec: HU-E11-01 (S5). WebhookEndpointStore over `webhook_endpoints`, run as app_user under RLS, with audit rows. */
describe('DrizzleWebhookEndpointStore', () => {
  let handle: DatabaseHandle;
  let tenantId: string;
  let otherTenantId: string;
  const id = '22222222-2222-4222-8222-222222222222';

  beforeEach(async () => {
    handle = createPgliteDatabase();
    await handle.migrate();
    const [a, b] = await handle.db
      .insert(tenants)
      .values([{ name: 'A' }, { name: 'B' }])
      .returning();
    [tenantId, otherTenantId] = [a.id, b.id];
  });
  afterEach(async () => {
    await handle.close();
  });

  const store = createDrizzleWebhookEndpointStore;
  const create = () =>
    store(handle.db).insert(tenantId, ACTOR, {
      id,
      url: 'https://hooks.example.com/x',
      events: ['document.approved'],
      sealed: SEALED,
    });
  const audit = (tenant = tenantId) =>
    withTenantTransaction(handle.db, tenant, (tx) =>
      tx.select().from(auditLog).orderBy(auditLog.seq),
    );

  it('inserts and lists endpoints without exposing any secret material, auditing the creation', async () => {
    const view = await create();
    expect(view).toMatchObject({
      id,
      url: 'https://hooks.example.com/x',
      events: ['document.approved'],
      active: true,
      secretVersion: 1,
      previousExpiresAt: null,
    });
    expect(Object.keys(view)).not.toContain('sealed');
    expect(await store(handle.db).list(tenantId)).toEqual([view]);
    const [row] = await audit();
    expect(row).toMatchObject({
      action: 'webhook_endpoint.create',
      entityType: 'webhook_endpoint',
      entityId: id,
      actorId: 'key-1',
    });
    expect(JSON.stringify(row)).not.toContain('ciphertext');
  });

  it('keeps every tenant to itself', async () => {
    await create();
    const other = store(handle.db);
    expect(await other.list(otherTenantId)).toEqual([]);
    expect(await other.find(otherTenantId, id)).toBeNull();
    expect(await other.update(otherTenantId, ACTOR, id, { active: false })).toBeNull();
    expect(
      await other.rotate(otherTenantId, ACTOR, id, {
        expectedVersion: 1,
        sealed: SEALED_2,
        previousSealed: SEALED,
        previousExpiresAt: new Date(Date.now() + DAY),
      }),
    ).toBeNull();
  });

  it('finds the row with its sealed secret for rotation', async () => {
    await create();
    expect(await store(handle.db).find(tenantId, id)).toMatchObject({
      id,
      secretVersion: 1,
      sealed: SEALED,
      previousSealed: null,
    });
  });

  it('updates url, events and active, auditing before and after', async () => {
    await create();
    const view = await store(handle.db).update(tenantId, ACTOR, id, {
      url: 'https://other.example.com/y',
      events: [],
      active: false,
    });
    expect(view).toMatchObject({ url: 'https://other.example.com/y', events: [], active: false });
    const [, row] = await audit();
    expect(row).toMatchObject({ action: 'webhook_endpoint.update' });
    expect(row.before).toMatchObject({ url: 'https://hooks.example.com/x', active: true });
    expect(row.after).toMatchObject({ url: 'https://other.example.com/y', active: false });
  });

  it('rotates through the guard: version + 1, previous kept, audited without secrets', async () => {
    await create();
    const view = await store(handle.db).rotate(tenantId, ACTOR, id, {
      expectedVersion: 1,
      sealed: SEALED_2,
      previousSealed: SEALED,
      previousExpiresAt: new Date(Date.now() + DAY),
    });
    expect(view).toMatchObject({ secretVersion: 2 });
    expect((view as { previousExpiresAt: Date }).previousExpiresAt).toBeInstanceOf(Date);
    const [row] = await handle.db
      .select()
      .from(webhookEndpoints)
      .where(eq(webhookEndpoints.id, id));
    expect(row).toMatchObject({ sealed: SEALED_2, previousSealed: SEALED, secretVersion: 2 });
    const [, rotated] = await audit();
    expect(rotated).toMatchObject({ action: 'webhook_endpoint.rotate_secret' });
    expect(JSON.stringify(rotated)).not.toContain('ciphertext');
  });

  it('reports a rotation that lost the race as stale and writes nothing', async () => {
    await create();
    const change = {
      expectedVersion: 5,
      sealed: SEALED_2,
      previousSealed: SEALED,
      previousExpiresAt: new Date(Date.now() + DAY),
    };
    expect(await store(handle.db).rotate(tenantId, ACTOR, id, change)).toBe('stale');
    expect((await audit()).length).toBe(1);
  });
});
