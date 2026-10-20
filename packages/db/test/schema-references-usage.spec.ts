import { describe, expect, it } from 'vitest';
import { getTableName } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { invoicesSaas, usageCounters } from '../src/schema.js';

const targets = (table: Parameters<typeof getTableConfig>[0]) =>
  getTableConfig(table)
    .foreignKeys.map((fk) => getTableName(fk.reference().foreignTable))
    .sort();

/** Resolves the lazy foreign key callbacks of the invoice and usage tables (HU-E15-01/02). */
describe('invoices_saas and usage_counters foreign key targets', () => {
  it('invoices_saas reference tenants and, with the tenant, their subscription', () => {
    expect(targets(invoicesSaas)).toEqual(['subscriptions', 'tenants']);
  });

  it('usage_counters reference tenants', () => {
    expect(targets(usageCounters)).toEqual(['tenants']);
  });
});
