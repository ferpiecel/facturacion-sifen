import { afterEach, describe, expect, it } from 'vitest';
import type { DatabaseHandle } from '../src/client.js';
import { tenants, webhookDeliveries, webhookEndpoints } from '../src/schema.js';
import { withTenantTransaction } from '../src/tenant-transaction.js';
import { createTestDatabase } from './support/harness.js';

const SEALED = {
  v: 1,
  keyId: 'k',
  wrappedKey: 'AA==',
  nonce: 'AA==',
  tag: 'AA==',
  ciphertext: 'AA==',
};

async function causeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    const cause = (error as { cause?: unknown }).cause;
    return cause instanceof Error ? cause.message : String(cause);
  }
  return expect.unreachable('expected the query to reject');
}

/** Spec: HU-E11-01 (DB part). Deliveries are the retry queue, the DLQ and the delivery history. */
describe('webhook_deliveries', () => {
  let handle: DatabaseHandle | undefined;

  afterEach(async () => {
    await handle?.close();
    handle = undefined;
  });

  async function seed() {
    handle = await createTestDatabase();
    const rows = await handle.db
      .insert(tenants)
      .values([{ name: 'A' }, { name: 'B' }])
      .returning();
    const [a, b] = rows.map((row) => row.id);
    const { db } = handle;
    const endpointFor = async (tenantId: string) => {
      const [ep] = await db
        .insert(webhookEndpoints)
        .values({ tenantId, url: 'https://example.com/hook', sealed: SEALED })
        .returning();
      return ep.id;
    };
    return { db: handle.db, a, b, endpointFor };
  }

  const delivery = (
    tenantId: string,
    endpointId: string,
    overrides: Partial<typeof webhookDeliveries.$inferInsert> = {},
  ): typeof webhookDeliveries.$inferInsert => ({
    tenantId,
    endpointId,
    eventId: 'evt_00000001',
    eventType: 'document.approved',
    payload: { id: 'evt_00000001' },
    nextAttemptAt: new Date('2026-09-22T00:00:00Z'),
    ...overrides,
  });

  it('queues a delivery as pending with no attempts, once per endpoint and event', async () => {
    const { db, a, endpointFor } = await seed();
    const ep = await endpointFor(a);
    const [row] = await db.insert(webhookDeliveries).values(delivery(a, ep)).returning();
    expect(row).toMatchObject({ status: 'pending', attemptCount: 0, lastStatusCode: null });
    expect(await causeOf(db.insert(webhookDeliveries).values(delivery(a, ep)))).toContain(
      'webhook_deliveries_endpoint_event_key',
    );
  });

  it('keeps next_attempt_at exactly while a delivery is still to be tried', async () => {
    const { db, a, endpointFor } = await seed();
    const ep = await endpointFor(a);
    const bad: Partial<typeof webhookDeliveries.$inferInsert>[] = [
      { nextAttemptAt: null },
      { status: 'delivered', deliveredAt: new Date() },
      { status: 'dead' },
      { status: 'bogus', nextAttemptAt: null },
      { eventType: 'document.nope' },
    ];
    for (const [i, override] of bad.entries()) {
      await expect(
        db
          .insert(webhookDeliveries)
          .values(delivery(a, ep, { eventId: `evt_0000000${String(i)}`, ...override })),
      ).rejects.toThrow();
    }
    await db
      .insert(webhookDeliveries)
      .values(delivery(a, ep, { status: 'dead', nextAttemptAt: null, attemptCount: 14 }));
  });

  it('refuses a delivery pointing at another tenant endpoint', async () => {
    const { db, a, b, endpointFor } = await seed();
    const ep = await endpointFor(b);
    expect(await causeOf(db.insert(webhookDeliveries).values(delivery(a, ep)))).toContain(
      'webhook_deliveries_tenant_endpoint_fk',
    );
  });

  it('isolates by tenant through RLS; app_user can insert and update, never delete', async () => {
    const { db, a, b, endpointFor } = await seed();
    await db
      .insert(webhookDeliveries)
      .values([delivery(a, await endpointFor(a)), delivery(b, await endpointFor(b))]);
    const seen = await withTenantTransaction(db, a, (tx) => tx.select().from(webhookDeliveries));
    expect(seen.map((r) => r.tenantId)).toEqual([a]);
    await withTenantTransaction(db, a, (tx) =>
      tx.update(webhookDeliveries).set({ attemptCount: 1, lastStatusCode: 500 }),
    );
    expect(
      await causeOf(withTenantTransaction(db, a, (tx) => tx.delete(webhookDeliveries))),
    ).toContain('permission denied for table webhook_deliveries');
  });

  it('freezes identity and payload, and only moves a delivery forward', async () => {
    const { db, a, b, endpointFor } = await seed();
    await db.insert(webhookDeliveries).values(delivery(a, await endpointFor(a)));
    for (const change of [{ tenantId: b }, { eventId: 'evt_99999999' }, { payload: { x: 1 } }]) {
      expect(await causeOf(db.update(webhookDeliveries).set(change))).toContain('immutable');
    }
    await db
      .update(webhookDeliveries)
      .set({ status: 'delivered', nextAttemptAt: null, deliveredAt: new Date(), attemptCount: 1 });
    expect(
      await causeOf(
        db.update(webhookDeliveries).set({ status: 'pending', nextAttemptAt: new Date() }),
      ),
    ).toContain('invalid status transition');
  });

  it('lets a dead delivery be replayed back to pending', async () => {
    const { db, a, endpointFor } = await seed();
    await db
      .insert(webhookDeliveries)
      .values(delivery(a, await endpointFor(a), { status: 'dead', nextAttemptAt: null }));
    const [row] = await db
      .update(webhookDeliveries)
      .set({ status: 'pending', nextAttemptAt: new Date() })
      .returning();
    expect(row.status).toBe('pending');
  });
});
