import { describe, expect, it } from 'vitest';
import { getTableName } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { payments, planPriceTiers, planPrices, plans, subscriptions } from '../src/schema.js';

const targets = (table: Parameters<typeof getTableConfig>[0]) =>
  getTableConfig(table).foreignKeys.map((fk) => getTableName(fk.reference().foreignTable));

/** Resolves the lazy foreign key callbacks of the billing tables (HU-E15-01). */
describe('billing schema foreign key targets', () => {
  it('plans reference nothing', () => {
    expect(targets(plans)).toEqual([]);
  });

  it('prices reference plans and tiers reference prices', () => {
    expect(targets(planPrices)).toEqual(['plans']);
    expect(targets(planPriceTiers)).toEqual(['plan_prices']);
  });

  it('subscriptions reference tenants and plans', () => {
    expect(targets(subscriptions).sort()).toEqual(['plans', 'tenants']);
  });

  it('payments reference tenants and, with the tenant, their subscription', () => {
    expect(targets(payments).sort()).toEqual(['subscriptions', 'tenants']);
  });
});
