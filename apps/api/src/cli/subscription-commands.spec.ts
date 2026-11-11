import {
  auditLog,
  createPgliteDatabase,
  payments,
  planPrices,
  subscriptions,
  type DatabaseHandle,
} from '@sifen/db';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTenant } from './commands.js';
import { setPlanPrice } from './plan-commands.js';
import { seedPlans } from './plan-seed.js';
import { assignSubscription, recordPayment } from './subscription-commands.js';

const NOW = new Date('2026-10-21T15:00:00Z');

/** Spec: HU-E15-01, subscription:assign snapshots the price in force; payment:record is manual and append-only. */
describe('subscription operator commands', () => {
  let handle: DatabaseHandle;
  let tenantId: string;

  beforeEach(async () => {
    handle = createPgliteDatabase();
    await handle.migrate();
    await seedPlans(handle.db, NOW);
    tenantId = (await createTenant(handle.db, 'Acme')).id;
  });
  afterEach(async () => {
    await handle.close();
  });

  describe('assignSubscription', () => {
    it('copies the terms of the price row valid on the start day', async () => {
      const result = await assignSubscription(handle.db, { tenantId, planCode: 'pyme' }, NOW);

      expect(result).toMatchObject({
        planCode: 'pyme',
        startsOn: '2026-10-21',
        monthlyPrice: 199000,
        overagePrice: 400,
        documentQuota: 500,
      });
      const [row] = await handle.db.select().from(subscriptions);
      expect(row).toMatchObject({
        tenantId,
        status: 'active',
        monthlyPrice: 199000,
        overagePrice: 400,
        documentQuota: 500,
      });
      expect(row.startsAt.toISOString()).toBe('2026-10-21T03:00:00.000Z');
      expect(row.nextBillingAt?.toISOString()).toBe('2026-11-21T03:00:00.000Z');
    });

    it('picks the price valid on the start day, not the latest one', async () => {
      await setPlanPrice(handle.db, {
        planCode: 'pyme',
        monthlyPrice: 250000,
        includedDocuments: 600,
        overagePrice: 350,
        validFrom: '2026-12-01',
        tiers: [],
      });

      const early = await assignSubscription(
        handle.db,
        { tenantId, planCode: 'pyme', startsOn: '2026-11-15' },
        NOW,
      );

      expect(early).toMatchObject({ monthlyPrice: 199000, documentQuota: 500 });
    });

    it('keeps the snapshot when the plan price changes later', async () => {
      await assignSubscription(handle.db, { tenantId, planCode: 'inicial' }, NOW);
      await setPlanPrice(handle.db, {
        planCode: 'inicial',
        monthlyPrice: 150000,
        includedDocuments: 120,
        overagePrice: 480,
        validFrom: '2026-11-01',
        tiers: [],
      });

      const [row] = await handle.db.select().from(subscriptions);
      expect(row.monthlyPrice).toBe(99000);
      expect(await handle.db.select().from(planPrices)).toHaveLength(5);
    });

    it('clamps the next billing date to the end of a shorter month', async () => {
      await assignSubscription(
        handle.db,
        { tenantId, planCode: 'inicial', startsOn: '2026-10-31' },
        NOW,
      );

      const [row] = await handle.db.select().from(subscriptions);
      expect(row.nextBillingAt?.toISOString()).toBe('2026-11-30T03:00:00.000Z');
    });

    it('audits the assignment in the tenant log', async () => {
      await assignSubscription(handle.db, { tenantId, planCode: 'inicial' }, NOW);

      const rows = await handle.db
        .select()
        .from(auditLog)
        .where(eq(auditLog.action, 'subscription.assigned'));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ tenantId, actorType: 'operator' });
    });

    it('refuses an unknown tenant, plan or start day, a plan without a price and a second live subscription', async () => {
      const assign = (params: Parameters<typeof assignSubscription>[1]) =>
        assignSubscription(handle.db, params, NOW);

      await expect(
        assign({ tenantId: '00000000-0000-4000-8000-000000000000', planCode: 'pyme' }),
      ).rejects.toThrow('tenant not found');
      await expect(assign({ tenantId, planCode: 'nope' })).rejects.toThrow('plan not found: nope');
      await expect(assign({ tenantId, planCode: 'pyme', startsOn: '2026-13-01' })).rejects.toThrow(
        'starts-on must be a valid',
      );
      await expect(assign({ tenantId, planCode: 'pyme', startsOn: '2026-01-01' })).rejects.toThrow(
        'has no price in force on 2026-01-01',
      );
      await assign({ tenantId, planCode: 'pyme' });
      await expect(assign({ tenantId, planCode: 'inicial' })).rejects.toThrow(
        'already has a live subscription',
      );
    });
  });

  describe('recordPayment', () => {
    it('appends a manual payment to the live subscription', async () => {
      const subscription = await assignSubscription(
        handle.db,
        { tenantId, planCode: 'inicial' },
        NOW,
      );

      const result = await recordPayment(
        handle.db,
        { tenantId, amount: 99000, reference: 'transf-123', paidOn: '2026-10-22' },
        NOW,
      );

      expect(result).toMatchObject({ subscriptionId: subscription.id, amount: 99000 });
      const [row] = await handle.db.select().from(payments);
      expect(row).toMatchObject({
        tenantId,
        method: 'manual',
        reference: 'transf-123',
        currency: 'PYG',
      });
      expect(row.paidAt.toISOString()).toBe('2026-10-22T03:00:00.000Z');
      expect(
        await handle.db.select().from(auditLog).where(eq(auditLog.action, 'payment.recorded')),
      ).toHaveLength(1);
    });

    it('defaults the payment time to now', async () => {
      await assignSubscription(handle.db, { tenantId, planCode: 'inicial' }, NOW);

      await recordPayment(handle.db, { tenantId, amount: 1 }, NOW);

      const [row] = await handle.db.select().from(payments);
      expect(row.paidAt).toEqual(NOW);
      expect(row.reference).toBeNull();
    });

    it('refuses a tenant without a subscription and a non-positive amount', async () => {
      await expect(recordPayment(handle.db, { tenantId, amount: 5 }, NOW)).rejects.toThrow(
        'no live subscription',
      );
      await expect(recordPayment(handle.db, { tenantId, amount: 0 }, NOW)).rejects.toThrow(
        'greater than zero',
      );
      await expect(
        recordPayment(handle.db, { tenantId, amount: 5, paidOn: 'x' }, NOW),
      ).rejects.toThrow('paid-on must be a valid');
    });
  });
});
