import {
  createPgliteDatabase,
  planPriceTiers,
  planPrices,
  plans,
  type DatabaseHandle,
} from '@sifen/db';
import { asc, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listPlans, setPlanPrice } from './plan-commands.js';

/** Spec: HU-E15-01, plan prices are effective-dated rows; a change never UPDATEs an amount. */
describe('plan operator commands', () => {
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

  /** Two plans with a first price valid from 2026-10-21 (what `plan:seed` would create). */
  const givePlans = async () => {
    await handle.db.insert(plans).values([
      { code: 'inicial', name: 'Inicial', audience: 'direct' },
      { code: 'partner', name: 'Partner', audience: 'partner' },
    ]);
    await setPlanPrice(handle.db, {
      planCode: 'inicial',
      monthlyPrice: 99000,
      includedDocuments: 100,
      overagePrice: 500,
      validFrom: '2026-10-21',
      tiers: [],
    });
    await setPlanPrice(handle.db, {
      planCode: 'partner',
      monthlyPrice: 0,
      includedDocuments: 0,
      overagePrice: 300,
      validFrom: '2026-10-21',
      tiers: [
        { fromDocuments: 0, unitPrice: 300 },
        { fromDocuments: 10000, unitPrice: 200 },
      ],
    });
  };

  describe('setPlanPrice', () => {
    const base = {
      planCode: 'inicial',
      monthlyPrice: 120000,
      includedDocuments: 150,
      overagePrice: 450,
      validFrom: '2026-11-01',
      tiers: [],
    };

    beforeEach(async () => {
      await givePlans();
    });

    it('inserts a new row and closes the previous one the day before', async () => {
      const result = await setPlanPrice(handle.db, base);

      expect(result.changed).toBe(true);
      expect(await pricesOf('inicial')).toEqual([
        {
          monthlyPrice: 99000,
          includedDocuments: 100,
          overagePrice: 500,
          validFrom: '2026-10-21',
          validTo: '2026-10-31',
        },
        {
          monthlyPrice: 120000,
          includedDocuments: 150,
          overagePrice: 450,
          validFrom: '2026-11-01',
          validTo: null,
        },
      ]);
    });

    it('does nothing when the terms are the ones already in force', async () => {
      const result = await setPlanPrice(handle.db, {
        ...base,
        monthlyPrice: 99000,
        includedDocuments: 100,
        overagePrice: 500,
      });

      expect(result.changed).toBe(false);
      expect(await pricesOf('inicial')).toHaveLength(1);
    });

    it('refuses a start that does not follow the current price', async () => {
      await expect(setPlanPrice(handle.db, { ...base, validFrom: '2026-10-21' })).rejects.toThrow(
        'valid-from must be after 2026-10-21',
      );
      await expect(setPlanPrice(handle.db, { ...base, validFrom: '2026-10-01' })).rejects.toThrow(
        'valid-from must be after',
      );
    });

    it('refuses a start before the last closed price ended', async () => {
      await setPlanPrice(handle.db, base);
      await handle.db
        .update(planPrices)
        .set({ validTo: '2026-11-30' })
        .where(eq(planPrices.monthlyPrice, 120000));

      await expect(setPlanPrice(handle.db, { ...base, validFrom: '2026-11-30' })).rejects.toThrow(
        'valid-from must be after 2026-11-30',
      );
    });

    it('refuses an unknown plan and an invalid date', async () => {
      await expect(setPlanPrice(handle.db, { ...base, planCode: 'nope' })).rejects.toThrow(
        'plan not found: nope',
      );
      await expect(setPlanPrice(handle.db, { ...base, validFrom: '2026-02-30' })).rejects.toThrow(
        'valid-from must be a valid YYYY-MM-DD date',
      );
    });

    it('stores tiers with the new row', async () => {
      await setPlanPrice(handle.db, {
        ...base,
        planCode: 'partner',
        monthlyPrice: 0,
        includedDocuments: 0,
        overagePrice: 250,
        tiers: [{ fromDocuments: 0, unitPrice: 250 }],
      });

      expect(await pricesOf('partner')).toHaveLength(2);
      expect(await handle.db.select().from(planPriceTiers)).toHaveLength(3);
    });
  });

  describe('listPlans', () => {
    it('shows the price in force on the given day, with tiers', async () => {
      const now = new Date('2026-10-21T12:00:00Z');
      await givePlans();

      const rows = await listPlans(handle.db, now);

      expect(rows.map((row) => row.code)).toEqual(['inicial', 'partner']);
      expect(rows.find((row) => row.code === 'inicial')).toMatchObject({
        audience: 'direct',
        active: true,
        monthlyPrice: 99000,
        includedDocuments: 100,
        overagePrice: 500,
        validFrom: '2026-10-21',
        tiers: [],
      });
      expect(rows.find((row) => row.code === 'partner')?.tiers).toEqual([
        { fromDocuments: 0, unitPrice: 300 },
        { fromDocuments: 10000, unitPrice: 200 },
      ]);
    });

    it('shows a plan without a price in force as unpriced', async () => {
      await givePlans();

      const rows = await listPlans(handle.db, new Date('2026-01-01T12:00:00Z'));

      expect(rows[0]).toMatchObject({ monthlyPrice: null, tiers: [] });
    });
  });
});
