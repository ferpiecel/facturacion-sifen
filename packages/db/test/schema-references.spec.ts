import { describe, expect, it } from 'vitest';
import { getTableName } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/pg-core';
import {
  apiKeys,
  documents,
  loteDocuments,
  lotes,
  partners,
  tenantEstablishments,
  tenantExpeditionPoints,
  tenantMemberships,
  tenantFiscalEconomicActivities,
  tenantFiscalProfiles,
  tenantProbe,
  tenants,
  tenantTimbrados,
  authEvents,
  userMfa,
  userSessions,
  users,
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
  expect(foreignKeys.map((fk) => getTableName(fk.reference().foreignTable))).toEqual(
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

  it('tenant_memberships references tenants and users; users has no foreign keys', () => {
    expectForeignKeyTargets(tenantMemberships, ['tenants', 'users']);
    expectForeignKeyTargets(users, []);
  });

  it('auth_events.user_id references users', () => {
    expectForeignKeyTargets(authEvents, ['users']);
  });

  it('user_sessions references users and tenants', () => {
    expectForeignKeyTargets(userSessions, ['users', 'tenants']);
  });

  it('user_mfa.user_id references users', () => {
    expectForeignKeyTargets(userMfa, ['users']);
  });

  it('partners has no foreign keys', () => {
    expectForeignKeyTargets(partners, []);
  });

  it('tenant_establishments.tenant_id references tenants', () => {
    expectForeignKeyTargets(tenantEstablishments, ['tenants']);
  });

  it('tenant_expedition_points references tenants and tenant_establishments', () => {
    expectForeignKeyTargets(tenantExpeditionPoints, ['tenants', 'tenant_establishments']);
  });

  it('tenant_timbrados.tenant_id references tenants', () => {
    expectForeignKeyTargets(tenantTimbrados, ['tenants']);
  });

  it('documents references tenants, its timbrado and its expedition point', () => {
    expect(
      getTableConfig(documents)
        .foreignKeys.map((fk) => getTableName(fk.reference().foreignTable))
        .sort(),
    ).toEqual(['tenant_expedition_points', 'tenant_timbrados', 'tenants']);
  });

  it('lotes.tenant_id references tenants', () => {
    expectForeignKeyTargets(lotes, ['tenants']);
  });

  it('lote_documents references tenants, lotes and documents', () => {
    expect(
      getTableConfig(loteDocuments)
        .foreignKeys.map((fk) => getTableName(fk.reference().foreignTable))
        .sort(),
    ).toEqual(['documents', 'lotes', 'tenants']);
  });
});
