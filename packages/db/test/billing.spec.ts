import { afterEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import type { DatabaseHandle } from '../src/client.js';
import { payments, plans, subscriptions, tenants } from '../src/schema.js';
import { withTenantTransaction } from '../src/tenant-transaction.js';
import { createTestDatabase } from './support/harness.js';

async function causeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    const cause = (error as { cause?: unknown }).cause;
    return cause instanceof Error ? cause.message : String(cause);
  }
  return expect.unreachable('expected the query to reject');
}

/** Spec: HU-E15-01 / HU-E15-02 (DB part). Plans are platform data; the rest is tenant-scoped. */
describe('billing tables', () => {
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
    const [plan] = await handle.db
      .insert(plans)
      .values({ code: 'starter', name: 'Starter' })
      .returning();
    return { db: handle.db, a, b, planId: plan.id };
  }

  it('stores a plan without price: prices are effective-dated plan_prices rows', async () => {
    const { db } = await seed();
    const [row] = await db
      .insert(plans)
      .values({ code: 'pro', name: 'Pro', apiCallLimit: 3000 })
      .returning();
    expect(row).toMatchObject({ currency: 'PYG', apiCallLimit: 3000, active: true, features: {} });
    expect(await causeOf(db.insert(plans).values({ code: 'Bad Code', name: 'x' }))).toContain(
      'plans_code_format',
    );
    expect(
      await causeOf(db.insert(plans).values({ code: 'neg', name: 'x', apiCallLimit: -1 })),
    ).toContain('plans_api_call_limit_nonneg');
  });

  it('lets a tenant read plans but not write them', async () => {
    const { db, a } = await seed();
    const seen = await withTenantTransaction(db, a, (tx) => tx.select().from(plans));
    expect(seen.map((p) => p.code)).toEqual(['starter']);
    expect(
      await causeOf(
        withTenantTransaction(db, a, (tx) => tx.insert(plans).values({ code: 'x', name: 'x' })),
      ),
    ).toContain('permission denied for table plans');
  });

  it('allows one live subscription per tenant; a cancelled one does not block a new plan', async () => {
    const { db, a, planId } = await seed();
    const [first] = await db
      .insert(subscriptions)
      .values({ tenantId: a, planId, status: 'active' })
      .returning();
    expect(
      await causeOf(db.insert(subscriptions).values({ tenantId: a, planId, status: 'trialing' })),
    ).toContain('subscriptions_one_live_per_tenant');
    await db
      .update(subscriptions)
      .set({ status: 'cancelled' })
      .where(sql`id = ${first.id}`);
    await db.insert(subscriptions).values({ tenantId: a, planId, status: 'active' });
    expect(
      await causeOf(db.insert(subscriptions).values({ tenantId: a, planId, status: 'bogus' })),
    ).toContain('subscriptions_status_valid');
  });

  it('isolates subscriptions, and payments by tenant and keeps them read-only for tenants', async () => {
    const { db, a, b, planId } = await seed();
    const [subA] = await db
      .insert(subscriptions)
      .values({ tenantId: a, planId, status: 'active' })
      .returning();
    const [subB] = await db
      .insert(subscriptions)
      .values({ tenantId: b, planId, status: 'active' })
      .returning();
    await db.insert(payments).values([
      { tenantId: a, subscriptionId: subA.id, amount: 100000, reference: 'dep-1' },
      { tenantId: b, subscriptionId: subB.id, amount: 100000, reference: 'dep-2' },
    ]);
    for (const table of [subscriptions, payments]) {
      const seen = await withTenantTransaction(db, a, (tx) => tx.select().from(table));
      expect(seen.map((r) => r.tenantId)).toEqual([a]);
    }
    expect(
      await causeOf(
        withTenantTransaction(db, a, (tx) =>
          tx.insert(payments).values({ tenantId: a, subscriptionId: subA.id, amount: 1 }),
        ),
      ),
    ).toContain('permission denied for table payments');
    expect(
      await causeOf(
        withTenantTransaction(db, a, (tx) => tx.update(subscriptions).set({ status: 'cancelled' })),
      ),
    ).toContain('permission denied for table subscriptions');
  });

  it('refuses a payment whose subscription belongs to another tenant', async () => {
    const { db, a, b, planId } = await seed();
    const [subB] = await db
      .insert(subscriptions)
      .values({ tenantId: b, planId, status: 'active' })
      .returning();
    expect(
      await causeOf(
        db.insert(payments).values({ tenantId: a, subscriptionId: subB.id, amount: 5 }),
      ),
    ).toContain('payments_subscription_fk');
  });

  it('rejects non-positive payments', async () => {
    const { db, a, planId } = await seed();
    const [sub] = await db
      .insert(subscriptions)
      .values({ tenantId: a, planId, status: 'active' })
      .returning();
    expect(
      await causeOf(db.insert(payments).values({ tenantId: a, subscriptionId: sub.id, amount: 0 })),
    ).toContain('payments_amount_positive');
  });
});
