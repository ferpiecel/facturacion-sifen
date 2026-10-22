import { and, eq, gte, isNull, lte, or } from 'drizzle-orm';
import { assertValidTenantId, plans, subscriptions, usageCounters, type Database } from '@sifen/db';
import { billingPeriod } from '../modules/billing/domain/billing-period.js';
import { asPlatformAdmin } from './platform-admin.js';

export interface UsageReport {
  tenantId: string;
  /** First day of the billing month (`YYYY-MM-01`, Paraguay calendar). */
  period: string;
  documentsIssued: number;
  apiCalls: number;
  notificationsSent: number;
  subscription: {
    id: string;
    planCode: string;
    documentQuota: number;
    overagePrice: number;
  } | null;
  /** Documents beyond the quota; 0 without a subscription. */
  overageDocuments: number;
  /** `overageDocuments * overagePrice` in guaraníes, from the subscription's own snapshot. */
  overageAmount: number;
  /** True from 80 % of a positive quota (PRD F7 warning); informational, nothing is enforced. */
  quotaWarning: boolean;
}

/** `YYYY-MM` (or a first-of-month `YYYY-MM-01`) to the first day of that month. */
function parsePeriod(value: string): string {
  const match = /^(\d{4})-(0[1-9]|1[0-2])(?:-01)?$/.exec(value);
  if (!match) throw new Error('period must be YYYY-MM');
  return `${match[1]}-${match[2]}-01`;
}

function nextMonthStart(period: string): string {
  const [year, month] = period.split('-').map(Number);
  const next = new Date(Date.UTC(year, month, 1));
  return next.toISOString().slice(0, 10);
}

/**
 * Operator CLI (HU-E15-02): the tenant's usage in a billing month against the quota and overage price
 * of the subscription live that month (its snapshot, never today's plan price). Read-only; the MVP
 * does not block or charge anything from it (PRD F7 enforcement is v1.0). Partner volume tiers are not
 * applied here: a partner subscription reports its flat snapshot overage price.
 */
export async function showUsage(
  db: Database,
  params: { tenantId: string; period?: string },
  now: Date,
): Promise<UsageReport> {
  assertValidTenantId(params.tenantId);
  const period = params.period === undefined ? billingPeriod(now) : parsePeriod(params.period);
  const periodEnd = nextMonthStart(period);
  return await asPlatformAdmin(db, async (tx) => {
    const usage = (
      await tx
        .select()
        .from(usageCounters)
        .where(and(eq(usageCounters.tenantId, params.tenantId), eq(usageCounters.period, period)))
    ).at(0);
    const row = (
      await tx
        .select({ subscription: subscriptions, planCode: plans.code })
        .from(subscriptions)
        .innerJoin(plans, eq(plans.id, subscriptions.planId))
        .where(
          and(
            eq(subscriptions.tenantId, params.tenantId),
            lte(subscriptions.startsAt, new Date(`${periodEnd}T00:00:00-03:00`)),
            or(
              isNull(subscriptions.endsAt),
              gte(subscriptions.endsAt, new Date(`${period}T00:00:00-03:00`)),
            ),
          ),
        )
        .orderBy(subscriptions.startsAt)
    ).at(-1);
    const documentsIssued = usage?.documentsIssued ?? 0;
    const { subscription } = row ?? {};
    const terms =
      row &&
      subscription &&
      subscription.documentQuota !== null &&
      subscription.overagePrice !== null
        ? {
            id: subscription.id,
            planCode: row.planCode,
            documentQuota: subscription.documentQuota,
            overagePrice: subscription.overagePrice,
          }
        : null;
    const overageDocuments = terms ? Math.max(0, documentsIssued - terms.documentQuota) : 0;
    return {
      tenantId: params.tenantId,
      period,
      documentsIssued,
      apiCalls: usage?.apiCalls ?? 0,
      notificationsSent: usage?.notificationsSent ?? 0,
      subscription: terms,
      overageDocuments,
      overageAmount: terms ? overageDocuments * terms.overagePrice : 0,
      quotaWarning:
        terms !== null &&
        terms.documentQuota > 0 &&
        documentsIssued * 10 >= terms.documentQuota * 8,
    };
  });
}
