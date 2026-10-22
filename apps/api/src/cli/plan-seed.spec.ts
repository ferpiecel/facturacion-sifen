import {
  createPgliteDatabase,
  planPriceTiers,
  planPrices,
  plans,
  type DatabaseHandle,
} from '@sifen/db';
import { asc, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setPlanPrice } from './plan-commands.js';
import { seedPlans } from './plan-seed.js';

/** Spec: HU-E15-01, `plan:seed` creates the PO plans as effective-dated price rows, idempotently. */
describe('seedPlans', () => {
  let handle: DatabaseHandle;

  beforeEach(async () => {
    handle = createPgliteDatabase();
    await handle.migrate();
  });
  afterEach(async () => {
    await handle.close();
  });

  const pricesOf = async (code: string) =>
    handle.db
      .select({
        monthlyPrice: planPrices.monthlyPrice,
        includedDocuments: planPrices.includedDocuments,
        overagePrice: planPrices.overagePrice,
        validFrom: planPrices.validFrom,
        validTo: planPrices.validTo,
      })
      .from(planPrices)
      .innerJoin(plans, eq(plans.id, planPrices.planId))
      .where(eq(plans.code, code))
      .orderBy(asc(planPrices.validFrom));

  it('seeds the four PO plans with an open price row valid from today', async () => {
    const result = await seedPlans(handle.db, new Date('2026-10-21T12:00:00Z'));

    expect(result.seeded.sort()).toEqual(['empresa', 'inicial', 'partner', 'pyme']);
    expect(await pricesOf('inicial')).toEqual([
      {
        monthlyPrice: 99000,
        includedDocuments: 100,
        overagePrice: 500,
        validFrom: '2026-10-21',
        validTo: null,
      },
    ]);
    expect((await pricesOf('pyme'))[0]).toMatchObject({
      monthlyPrice: 199000,
      includedDocuments: 500,
      overagePrice: 400,
    });
    expect((await pricesOf('empresa'))[0]).toMatchObject({
      monthlyPrice: 399000,
      includedDocuments: 2000,
      overagePrice: 300,
    });
  });

  it('seeds the partner plan as per-document tiers', async () => {
    await seedPlans(handle.db, new Date('2026-10-21T12:00:00Z'));

    const [plan] = await handle.db.select().from(plans).where(eq(plans.code, 'partner'));
    expect(plan.audience).toBe('partner');
    const tiers = await handle.db
      .select({ from: planPriceTiers.fromDocuments, unit: planPriceTiers.unitPrice })
      .from(planPriceTiers)
      .orderBy(asc(planPriceTiers.fromDocuments));
    expect(tiers).toEqual([
      { from: 0, unit: 300 },
      { from: 10000, unit: 200 },
    ]);
  });

  it('is idempotent and never overrides a price an operator already set', async () => {
    await seedPlans(handle.db, new Date('2026-10-21T12:00:00Z'));
    await setPlanPrice(handle.db, {
      planCode: 'inicial',
      monthlyPrice: 120000,
      includedDocuments: 150,
      overagePrice: 450,
      validFrom: '2026-11-01',
      tiers: [],
    });

    const again = await seedPlans(handle.db, new Date('2026-12-01T12:00:00Z'));

    expect(again.seeded).toEqual([]);
    expect(await pricesOf('inicial')).toHaveLength(2);
    expect(await handle.db.select().from(plans)).toHaveLength(4);
  });
});
