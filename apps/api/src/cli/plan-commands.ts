import { and, asc, desc, eq, isNull, lte, or, gte } from 'drizzle-orm';
import { planPriceTiers, planPrices, plans, type Database } from '@sifen/db';
import { asPlatformAdmin } from './platform-admin.js';
import { billingDate } from '../modules/billing/domain/billing-period.js';

export interface PlanTier {
  fromDocuments: number;
  unitPrice: number;
}

export interface PlanTerms {
  monthlyPrice: number;
  includedDocuments: number;
  overagePrice: number;
  tiers: PlanTier[];
}

export interface SetPlanPriceParams extends PlanTerms {
  planCode: string;
  /** First day (`YYYY-MM-DD`, inclusive) the new terms apply. */
  validFrom: string;
}

const DAY_MS = 86_400_000;

export function parseDate(value: string, flag: string): Date {
  const date = new Date(`${value}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(date.getTime())) {
    throw new Error(`${flag} must be a valid YYYY-MM-DD date`);
  }
  if (date.toISOString().slice(0, 10) !== value) {
    throw new Error(`${flag} must be a valid YYYY-MM-DD date`);
  }
  return date;
}

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function sameTiers(a: PlanTier[], b: PlanTier[]): boolean {
  const key = (tiers: PlanTier[]) =>
    tiers
      .map((tier) => `${String(tier.fromDocuments)}:${String(tier.unitPrice)}`)
      .sort()
      .join(',');
  return key(a) === key(b);
}

/**
 * Operator CLI (HU-E15-01): sets a plan's terms from `validFrom`. The previous row is closed the day
 * before (only `valid_to` is written) and a new row is inserted, so an amount is never UPDATEd and a
 * subscription's history stays intact. Identical terms in force are a no-op.
 */
export function setPlanPrice(
  db: Database,
  params: SetPlanPriceParams,
): Promise<{ changed: boolean }> {
  return asPlatformAdmin(db, { purpose: 'plan:price-set', scope: ['plans', 'plan_prices'] }, (tx) =>
    setPlanPriceIn(tx, params),
  );
}

/** {@link setPlanPrice} inside a caller-owned `platform_admin` transaction. */
export async function setPlanPriceIn(
  tx: Database,
  params: SetPlanPriceParams,
): Promise<{ changed: boolean }> {
  const from = parseDate(params.validFrom, 'valid-from');
  const plan = (await tx.select().from(plans).where(eq(plans.code, params.planCode))).at(0);
  if (!plan) throw new Error(`plan not found: ${params.planCode}`);
  const latest = (
    await tx
      .select()
      .from(planPrices)
      .where(eq(planPrices.planId, plan.id))
      .orderBy(desc(planPrices.validFrom))
      .limit(1)
  ).at(0);
  if (latest) {
    const tiers = await tx
      .select({
        fromDocuments: planPriceTiers.fromDocuments,
        unitPrice: planPriceTiers.unitPrice,
      })
      .from(planPriceTiers)
      .where(eq(planPriceTiers.planPriceId, latest.id));
    if (
      latest.validTo === null &&
      latest.monthlyPrice === params.monthlyPrice &&
      latest.includedDocuments === params.includedDocuments &&
      latest.overagePrice === params.overagePrice &&
      sameTiers(tiers, params.tiers)
    ) {
      return { changed: false };
    }
    const floor = latest.validTo ?? latest.validFrom;
    if (params.validFrom <= floor) {
      throw new Error(`valid-from must be after ${floor}`);
    }
    if (latest.validTo === null) {
      await tx
        .update(planPrices)
        .set({ validTo: isoDay(new Date(from.getTime() - DAY_MS)) })
        .where(eq(planPrices.id, latest.id));
    }
  }
  const [row] = await tx
    .insert(planPrices)
    .values({
      planId: plan.id,
      monthlyPrice: params.monthlyPrice,
      includedDocuments: params.includedDocuments,
      overagePrice: params.overagePrice,
      validFrom: params.validFrom,
    })
    .returning({ id: planPrices.id });
  if (params.tiers.length > 0) {
    await tx
      .insert(planPriceTiers)
      .values(params.tiers.map((tier) => ({ ...tier, planPriceId: row.id })));
  }
  return { changed: true };
}

export interface PlanListing {
  code: string;
  name: string;
  audience: string;
  active: boolean;
  monthlyPrice: number | null;
  includedDocuments: number | null;
  overagePrice: number | null;
  validFrom: string | null;
  tiers: PlanTier[];
}

/** Operator CLI: every plan with the price row in force on `now` (Paraguay day), tiers included. */
export function listPlans(db: Database, now: Date): Promise<PlanListing[]> {
  return asPlatformAdmin(
    db,
    { purpose: 'plan:list', scope: ['plans', 'plan_prices'], rowCount: (plans) => plans.length },
    (tx) => listPlansIn(tx, now),
  );
}

async function listPlansIn(db: Database, now: Date): Promise<PlanListing[]> {
  const today = billingDate(now);
  const rows = await db
    .select({ plan: plans, price: planPrices })
    .from(plans)
    .leftJoin(
      planPrices,
      and(
        eq(planPrices.planId, plans.id),
        lte(planPrices.validFrom, today),
        or(isNull(planPrices.validTo), gte(planPrices.validTo, today)),
      ),
    )
    .orderBy(asc(plans.code));
  const result: PlanListing[] = [];
  for (const { plan, price } of rows) {
    const tiers = price
      ? await db
          .select({
            fromDocuments: planPriceTiers.fromDocuments,
            unitPrice: planPriceTiers.unitPrice,
          })
          .from(planPriceTiers)
          .where(eq(planPriceTiers.planPriceId, price.id))
          .orderBy(asc(planPriceTiers.fromDocuments))
      : [];
    result.push({
      code: plan.code,
      name: plan.name,
      audience: plan.audience,
      active: plan.active,
      monthlyPrice: price?.monthlyPrice ?? null,
      includedDocuments: price?.includedDocuments ?? null,
      overagePrice: price?.overagePrice ?? null,
      validFrom: price?.validFrom ?? null,
      tiers,
    });
  }
  return result;
}
