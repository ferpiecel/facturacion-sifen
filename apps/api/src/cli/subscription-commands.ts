import { and, desc, eq, gte, isNull, lte, ne, or, sql } from 'drizzle-orm';
import {
  assertValidTenantId,
  payments,
  planPrices,
  plans,
  subscriptions,
  tenants,
  type Database,
} from '@sifen/db';
import { recordAudit } from '../modules/audit/infrastructure/record-audit.js';
import { billingDate } from '../modules/billing/domain/billing-period.js';
import { parseDate } from './plan-commands.js';
import { asPlatformAdmin } from './platform-admin.js';

const OPERATOR = { type: 'operator', id: 'ops-cli' } as const;
/** Paraguay civil midnight (UTC-3, no DST): a day `YYYY-MM-DD` starts at this instant. */
const dayStart = (day: string): Date => new Date(`${day}T00:00:00-03:00`);

/** The same day one month later, clamped to the end of a shorter month. */
function addMonth(day: string): string {
  const base = parseDate(day, 'starts-on');
  const target = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 1, 1));
  const lastDay = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(base.getUTCDate(), lastDay));
  return target.toISOString().slice(0, 10);
}

/** Binds the audit context to the tenant inside a `platform_admin` transaction. */
async function bindTenant(tx: Database, tenantId: string): Promise<void> {
  assertValidTenantId(tenantId);
  await tx.execute(sql`select set_config('app.current_tenant', ${tenantId}, true)`);
  const found = await tx.select({ id: tenants.id }).from(tenants).where(eq(tenants.id, tenantId));
  if (found.length === 0) throw new Error(`tenant not found: ${tenantId}`);
}

export interface AssignSubscriptionParams {
  tenantId: string;
  planCode: string;
  /** `YYYY-MM-DD` (Paraguay day) the subscription starts; defaults to today. */
  startsOn?: string;
}

export interface AssignedSubscription {
  id: string;
  planCode: string;
  startsOn: string;
  monthlyPrice: number;
  overagePrice: number;
  documentQuota: number;
}

/**
 * Operator CLI (HU-E15-01): subscribes a tenant to a plan. The terms are copied from the
 * `plan_prices` row valid on the start day into the subscription (immutable snapshot, migration 0054),
 * so a later price change never touches it. One live subscription per tenant (partial unique index);
 * the operator cancels or lets it end before assigning another. Audited.
 */
export async function assignSubscription(
  db: Database,
  params: AssignSubscriptionParams,
  now: Date,
): Promise<AssignedSubscription> {
  const startsOn = params.startsOn ?? billingDate(now);
  parseDate(startsOn, 'starts-on');
  return await asPlatformAdmin(db, async (tx) => {
    await bindTenant(tx, params.tenantId);
    const plan = (await tx.select().from(plans).where(eq(plans.code, params.planCode))).at(0);
    if (!plan) throw new Error(`plan not found: ${params.planCode}`);
    if (!plan.active) throw new Error(`plan is not active: ${params.planCode}`);
    const price = (
      await tx
        .select()
        .from(planPrices)
        .where(
          and(
            eq(planPrices.planId, plan.id),
            lte(planPrices.validFrom, startsOn),
            or(isNull(planPrices.validTo), gte(planPrices.validTo, startsOn)),
          ),
        )
    ).at(0);
    if (!price) throw new Error(`plan ${plan.code} has no price in force on ${startsOn}`);
    const live = (
      await tx
        .select({ id: subscriptions.id })
        .from(subscriptions)
        .where(
          and(eq(subscriptions.tenantId, params.tenantId), ne(subscriptions.status, 'cancelled')),
        )
    ).at(0);
    if (live) throw new Error(`tenant already has a live subscription: ${live.id}`);
    const [row] = await tx
      .insert(subscriptions)
      .values({
        tenantId: params.tenantId,
        planId: plan.id,
        monthlyPrice: price.monthlyPrice,
        overagePrice: price.overagePrice,
        documentQuota: price.includedDocuments,
        startsAt: dayStart(startsOn),
        nextBillingAt: dayStart(addMonth(startsOn)),
      })
      .returning({ id: subscriptions.id });
    await recordAudit(tx, {
      actor: OPERATOR,
      action: 'subscription.assigned',
      entity: { type: 'subscription', id: row.id },
      before: null,
      after: {
        plan: plan.code,
        startsOn,
        monthlyPrice: price.monthlyPrice,
        overagePrice: price.overagePrice,
        documentQuota: price.includedDocuments,
      },
    });
    return {
      id: row.id,
      planCode: plan.code,
      startsOn,
      monthlyPrice: price.monthlyPrice,
      overagePrice: price.overagePrice,
      documentQuota: price.includedDocuments,
    };
  });
}

export interface RecordPaymentParams {
  tenantId: string;
  /** Whole guaraníes, greater than zero. */
  amount: number;
  reference?: string;
  /** `YYYY-MM-DD` (Paraguay day) the money arrived; defaults to now. */
  paidOn?: string;
}

/**
 * Operator CLI (HU-E15-01): records a manual payment (`method = 'manual'`, no gateway before v1.0)
 * against the tenant's live subscription. Payments are append-only; a mistake is corrected by a new
 * row, never an edit. Audited.
 */
export async function recordPayment(
  db: Database,
  params: RecordPaymentParams,
  now: Date,
): Promise<{ id: string; subscriptionId: string; amount: number }> {
  if (!Number.isSafeInteger(params.amount) || params.amount <= 0) {
    throw new Error('amount must be a whole number greater than zero');
  }
  if (params.paidOn !== undefined) parseDate(params.paidOn, 'paid-on');
  return await asPlatformAdmin(db, async (tx) => {
    await bindTenant(tx, params.tenantId);
    const subscription = (
      await tx
        .select({ id: subscriptions.id })
        .from(subscriptions)
        .where(
          and(eq(subscriptions.tenantId, params.tenantId), ne(subscriptions.status, 'cancelled')),
        )
        .orderBy(desc(subscriptions.startsAt))
    ).at(0);
    if (!subscription) throw new Error(`tenant has no live subscription: ${params.tenantId}`);
    const [row] = await tx
      .insert(payments)
      .values({
        tenantId: params.tenantId,
        subscriptionId: subscription.id,
        amount: params.amount,
        reference: params.reference ?? null,
        paidAt: params.paidOn ? dayStart(params.paidOn) : now,
      })
      .returning({ id: payments.id });
    await recordAudit(tx, {
      actor: OPERATOR,
      action: 'payment.recorded',
      entity: { type: 'payment', id: row.id },
      before: null,
      after: { subscriptionId: subscription.id, amount: params.amount },
    });
    return { id: row.id, subscriptionId: subscription.id, amount: params.amount };
  });
}
