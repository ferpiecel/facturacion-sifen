import { eq } from 'drizzle-orm';
import { planPrices, plans, type Database } from '@sifen/db';
import { billingDate } from '../modules/billing/domain/billing-period.js';
import { setPlanPrice, type PlanTerms } from './plan-commands.js';

interface SeedPlan extends PlanTerms {
  code: string;
  name: string;
  audience: 'direct' | 'partner';
}

/** PO provisional prices (2026-10): editable afterwards with `plan:price-set`, never constants of the product. */
const SEED_PLANS: SeedPlan[] = [
  {
    code: 'inicial',
    name: 'Inicial',
    audience: 'direct',
    monthlyPrice: 99000,
    includedDocuments: 100,
    overagePrice: 500,
    tiers: [],
  },
  {
    code: 'pyme',
    name: 'PyME',
    audience: 'direct',
    monthlyPrice: 199000,
    includedDocuments: 500,
    overagePrice: 400,
    tiers: [],
  },
  {
    code: 'empresa',
    name: 'Empresa',
    audience: 'direct',
    monthlyPrice: 399000,
    includedDocuments: 2000,
    overagePrice: 300,
    tiers: [],
  },
  {
    code: 'partner',
    name: 'Partner',
    audience: 'partner',
    monthlyPrice: 0,
    includedDocuments: 0,
    overagePrice: 300,
    tiers: [
      { fromDocuments: 0, unitPrice: 300 },
      { fromDocuments: 10000, unitPrice: 200 },
    ],
  },
];

/**
 * Operator CLI: creates the PO plans and, only for a plan that has no price row yet, its first price
 * valid from today. Re-running it (or running it after `plan:price-set`) changes nothing.
 */
export async function seedPlans(db: Database, now: Date): Promise<{ seeded: string[] }> {
  const seeded: string[] = [];
  const today = billingDate(now);
  for (const seed of SEED_PLANS) {
    await db
      .insert(plans)
      .values({ code: seed.code, name: seed.name, audience: seed.audience })
      .onConflictDoNothing({ target: plans.code });
    const [plan] = await db.select({ id: plans.id }).from(plans).where(eq(plans.code, seed.code));
    const existing = await db
      .select({ id: planPrices.id })
      .from(planPrices)
      .where(eq(planPrices.planId, plan.id))
      .limit(1);
    if (existing.length > 0) continue;
    await setPlanPrice(db, { ...seed, planCode: seed.code, validFrom: today });
    seeded.push(seed.code);
  }
  return { seeded };
}
