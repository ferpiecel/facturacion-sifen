import { describe, expect, it } from 'vitest';
import { getTableConfig } from 'drizzle-orm/pg-core';
import {
  apiKeys,
  partners,
  tenantFiscalEconomicActivities,
  tenantFiscalProfiles,
  tenantProbe,
  tenants,
} from '../src/schema.js';

/**
 * Resolves every inline `.references(() => ...)` foreign key on `table` and
 * asserts it points at `expectedTableName`. This exercises the lazy
 * reference callbacks (only invoked by drizzle-kit or `getTableConfig`, not
 * by the migration runner itself), so a foreign key pointed at the wrong
 * table is caught here instead of only at `drizzle-kit generate` time.
 */
function expectForeignKeyTargets(
  table: Parameters<typeof getTableConfig>[0],
  expectedTableNames: string[],
): void {
  const { foreignKeys } = getTableConfig(table);
  expect(foreignKeys).toHaveLength(expectedTableNames.length);
  expect(foreignKeys.map((fk) => fk.reference().foreignTable[Symbol.for('drizzle:Name')])).toEqual(
    expectedTableNames,
  );
}

describe('schema foreign key targets', () => {
  it('tenants.partner_id references partners', () => {
    expectForeignKeyTargets(tenants, ['partners']);
  });

  it('tenant_probe.tenant_id references tenants', () => {
    expectForeignKeyTargets(tenantProbe, ['tenants']);
  });

  it('api_keys.tenant_id references tenants', () => {
    expectForeignKeyTargets(apiKeys, ['tenants']);
  });

  it('tenant_fiscal_profiles.tenant_id references tenants', () => {
    expectForeignKeyTargets(tenantFiscalProfiles, ['tenants']);
  });

  it('tenant_fiscal_economic_activities.tenant_id references tenants', () => {
    expectForeignKeyTargets(tenantFiscalEconomicActivities, ['tenants']);
  });

  it('partners has no foreign keys', () => {
    expectForeignKeyTargets(partners, []);
  });
});
