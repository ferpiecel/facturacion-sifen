import { afterEach, describe, expect, it } from 'vitest';
import type { DatabaseHandle } from '../src/client.js';
import { planPrices, planPriceTiers, plans, subscriptions, tenants } from '../src/schema.js';
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

/** Spec: HU-E15-01. Prices are effective-dated rows, never a mutable column on the plan. */
describe('plan prices', () => {
  let handle: DatabaseHandle | undefined;

  afterEach(async () => {
    await handle?.close();
    handle = undefined;
  });

  async function seed() {
    handle = await createTestDatabase();
    const [tenant] = await handle.db.insert(tenants).values({ name: 'A' }).returning();
    const [plan] = await handle.db
      .insert(plans)
      .values({ code: 'inicial', name: 'Inicial' })
      .returning();
    const [other] = await handle.db
      .insert(plans)
      .values({ code: 'pyme', name: 'PyME' })
      .returning();
    return { db: handle.db, tenantId: tenant.id, planId: plan.id, otherId: other.id };
  }

  const terms = { monthlyPrice: 99000, includedDocuments: 100, overagePrice: 500 };

  it('keeps price history: a later price coexists with the earlier one', async () => {
    const { db, planId } = await seed();
    await db
      .insert(planPrices)
      .values({ planId, ...terms, validFrom: '2026-01-01', validTo: '2026-06-30' });
    await db
      .insert(planPrices)
      .values({ planId, ...terms, monthlyPrice: 120000, validFrom: '2026-07-01' });
    const rows = await db.select().from(planPrices);
    expect(rows.map((r) => r.monthlyPrice).sort()).toEqual([120000, 99000]);
  });

  it('rejects overlapping validity for the same plan, allows it for another plan', async () => {
    const { db, planId, otherId } = await seed();
    await db.insert(planPrices).values({ planId, ...terms, validFrom: '2026-01-01' });
    expect(
      await causeOf(db.insert(planPrices).values({ planId, ...terms, validFrom: '2026-03-01' })),
    ).toContain('plan_prices_no_overlap');
    await db.insert(planPrices).values({ planId: otherId, ...terms, validFrom: '2026-03-01' });
  });

  it('rejects negative amounts and an inverted validity range', async () => {
    const { db, planId } = await seed();
    expect(
      await causeOf(
        db
          .insert(planPrices)
          .values({ planId, ...terms, overagePrice: -1, validFrom: '2026-01-01' }),
      ),
    ).toContain('plan_prices_amounts_nonneg');
    expect(
      await causeOf(
        db
          .insert(planPrices)
          .values({ planId, ...terms, validFrom: '2026-02-01', validTo: '2026-01-01' }),
      ),
    ).toContain('plan_prices_valid_range');
  });

  it('models partner volume tiers per price row', async () => {
    const { db, planId } = await seed();
    const [price] = await db
      .insert(planPrices)
      .values({
        planId,
        monthlyPrice: 0,
        includedDocuments: 0,
        overagePrice: 0,
        validFrom: '2026-01-01',
      })
      .returning();
    await db.insert(planPriceTiers).values([
      { planPriceId: price.id, fromDocuments: 0, unitPrice: 300 },
      { planPriceId: price.id, fromDocuments: 10000, unitPrice: 200 },
    ]);
    expect(
      await causeOf(
        db.insert(planPriceTiers).values({ planPriceId: price.id, fromDocuments: 0, unitPrice: 1 }),
      ),
    ).toContain('plan_price_tiers_price_from_key');
  });

  it('lets a tenant read prices but not write them', async () => {
    const { db, tenantId, planId } = await seed();
    await db.insert(planPrices).values({ planId, ...terms, validFrom: '2026-01-01' });
    const seen = await withTenantTransaction(db, tenantId, (tx) => tx.select().from(planPrices));
    expect(seen).toHaveLength(1);
    expect(
      await causeOf(
        withTenantTransaction(db, tenantId, (tx) =>
          tx.insert(planPrices).values({ planId, ...terms, validFrom: '2027-01-01' }),
        ),
      ),
    ).toContain('permission denied for table plan_prices');
  });

  it('rejects a subscription that ends before it starts', async () => {
    const { db, tenantId, planId } = await seed();
    expect(
      await causeOf(
        db.insert(subscriptions).values({
          tenantId,
          planId,
          startsAt: new Date('2026-02-01'),
          endsAt: new Date('2026-01-01'),
        }),
      ),
    ).toContain('subscriptions_period_valid');
  });
});
