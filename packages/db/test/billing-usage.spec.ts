import { afterEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import type { DatabaseHandle } from '../src/client.js';
import { invoicesSaas, plans, subscriptions, tenants, usageCounters } from '../src/schema.js';
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

const PERIOD = '2026-10-01';

/** Spec: HU-E15-01 (SaaS invoices) and HU-E15-02 (usage counters), DB part. */
describe('invoices_saas and usage_counters', () => {
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
    const { db } = handle;
    const sub = (tenantId: string) =>
      db
        .insert(subscriptions)
        .values({ tenantId, planId: plan.id })
        .returning()
        .then((r) => r[0].id);
    return { db, a, b, subA: await sub(a), subB: await sub(b) };
  }

  const invoice = (tenantId: string, subscriptionId: string, period = PERIOD) => ({
    tenantId,
    subscriptionId,
    period,
    amount: 100000,
  });

  it('isolates invoices by tenant, read-only for the tenant', async () => {
    const { db, a, b, subA, subB } = await seed();
    await db.insert(invoicesSaas).values([invoice(a, subA), invoice(b, subB)]);
    const seen = await withTenantTransaction(db, a, (tx) => tx.select().from(invoicesSaas));
    expect(seen.map((r) => r.tenantId)).toEqual([a]);
    expect(
      await causeOf(
        withTenantTransaction(db, a, (tx) =>
          tx.insert(invoicesSaas).values(invoice(a, subA, '2026-11-01')),
        ),
      ),
    ).toContain('permission denied for table invoices_saas');
  });

  it('refuses an invoice of another tenant subscription, an off-month period and a duplicate period', async () => {
    const { db, a, subA, subB } = await seed();
    expect(await causeOf(db.insert(invoicesSaas).values(invoice(a, subB)))).toContain(
      'invoices_saas_subscription_fk',
    );
    expect(await causeOf(db.insert(invoicesSaas).values(invoice(a, subA, '2026-10-15')))).toContain(
      'invoices_saas_period_first_day',
    );
    await db.insert(invoicesSaas).values(invoice(a, subA));
    expect(await causeOf(db.insert(invoicesSaas).values(invoice(a, subA)))).toContain(
      'invoices_saas_subscription_period_key',
    );
  });

  describe('usage_counters', () => {
    const bump = (db: DatabaseHandle['db'], tenantId: string, n = 1) =>
      withTenantTransaction(db, tenantId, (tx) =>
        tx.execute(sql`insert into usage_counters (tenant_id, period, documents_issued)
          values (${tenantId}, ${PERIOD}, ${n})
          on conflict (tenant_id, period)
          do update set documents_issued = usage_counters.documents_issued + excluded.documents_issued`),
      );

    it('increments atomically under concurrent writers (no lost updates)', async () => {
      const { db, a } = await seed();
      await Promise.all(Array.from({ length: 20 }, () => bump(db, a)));
      const [row] = await db.select().from(usageCounters);
      expect(row).toMatchObject({ documentsIssued: 20, apiCalls: 0, notificationsSent: 0 });
    });

    it('isolates counters by tenant and refuses cross-tenant writes', async () => {
      const { db, a, b } = await seed();
      await bump(db, a, 3);
      await bump(db, b, 5);
      const seen = await withTenantTransaction(db, a, (tx) => tx.select().from(usageCounters));
      expect(seen.map((r) => [r.tenantId, r.documentsIssued])).toEqual([[a, 3]]);
      expect(
        await causeOf(
          withTenantTransaction(db, a, (tx) =>
            tx.insert(usageCounters).values({ tenantId: b, period: PERIOD }),
          ),
        ),
      ).toContain('row-level security');
    });

    it('never lets a counter go down, change identity, or start off the first of the month', async () => {
      const { db, a } = await seed();
      await bump(db, a, 4);
      expect(
        await causeOf(
          withTenantTransaction(db, a, (tx) =>
            tx.update(usageCounters).set({ documentsIssued: 1 }),
          ),
        ),
      ).toContain('usage_counters: counters can only increase');
      expect(await causeOf(db.update(usageCounters).set({ period: '2026-11-01' }))).toContain(
        'usage_counters: identity columns are immutable',
      );
      expect(
        await causeOf(db.insert(usageCounters).values({ tenantId: a, period: '2026-09-02' })),
      ).toContain('usage_counters_period_first_day');
    });
  });
});
