import { sql } from 'drizzle-orm';
import {
  check,
  index,
  pgEnum,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

/**
 * Partners master table (HU-E1-05 / ADR-0014): a partner owns N tenants
 * (`tenants.partner_id`). Partner RLS/visibility is HU-E1-06, not this
 * story — deliberately no `GRANT` to `app_user` (or `platform_admin`) here,
 * so the table stays unreachable from request/job code exactly like before
 * this migration; only the operator's own connection (never `app_login`)
 * reads or writes it for now.
 */
export const partners = pgTable('partners', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: varchar('name', { length: 255 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Tenants master table: the source of truth every tenant-scoped table
 * references. It has no `tenant_id` column, but RLS still limits `app_user`
 * to its own row (`id = app.current_tenant`).
 */
export const tenants = pgTable(
  'tenants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: varchar('name', { length: 255 }).notNull(),
    // Nullable: direct SaaS tenants have no partner (ADR-0014).
    partnerId: uuid('partner_id').references(() => partners.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('tenants_partner_id_idx').on(table.partnerId)],
);

/**
 * Minimal tenant-scoped table used only by the isolation and RLS-drift test
 * suites (Phase 2) to prove the RLS policies without depending on any real
 * domain table.
 */
export const tenantProbe = pgTable(
  'tenant_probe',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    label: varchar('label', { length: 255 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  // Every RLS policy filters on tenant_id, so each tenant-scoped table indexes it.
  (table) => [index('tenant_probe_tenant_id_idx').on(table.tenantId)],
);

/** `api_keys.environment`: which SIFEN environment a key authenticates against. */
export const apiKeyEnvironment = pgEnum('api_key_environment', ['live', 'test']);

/**
 * API keys issued per tenant (HU-E1-04). `key_id` is the public identifier
 * embedded in the issued key (`sk_live_<key_id>` / `sk_test_<key_id>`);
 * `secret_hash` is the Argon2id PHC string of the secret part, hashed by the
 * application, never in SQL. Pre-authentication lookup (before tenant
 * context exists) goes through the `resolve_api_key` / `touch_api_key_last_used`
 * SECURITY DEFINER functions in migration 0003, never a direct query.
 */
export const apiKeys = pgTable(
  'api_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    keyId: text('key_id').notNull(),
    environment: apiKeyEnvironment('environment').notNull(),
    secretHash: text('secret_hash').notNull(),
    scopes: text('scopes').array().notNull().default([]),
    label: varchar('label', { length: 255 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  },
  (table) => [
    index('api_keys_tenant_id_idx').on(table.tenantId),
    uniqueIndex('api_keys_key_id_idx').on(table.keyId),
    check('api_keys_key_id_format', sql`${table.keyId} ~ '^[A-Za-z0-9]{24,64}$'`),
  ],
);

/** `tenant_fiscal_profiles.taxpayer_type`: iTipCont (MT v150 §D2, D103). */
export const fiscalTaxpayerType = pgEnum('fiscal_taxpayer_type', [
  'persona_fisica',
  'persona_juridica',
]);

/**
 * One fiscal profile per tenant (HU-E2-01 / RF-15): RUC + check digit,
 * legal/trade name, taxpayer type (iTipCont) and the optional regime code
 * (cTipReg). `tenant_id` is the primary key, not a separate `id`, since the
 * relationship is one row per tenant.
 */
export const tenantFiscalProfiles = pgTable(
  'tenant_fiscal_profiles',
  {
    tenantId: uuid('tenant_id')
      .primaryKey()
      .references(() => tenants.id),
    // dRucEm (MT §D2, D101): 3-8 digits, without the check digit.
    rucBase: varchar('ruc_base', { length: 8 }).notNull(),
    // dDVEmi (MT §D2, D102): SET modulo-11 check digit, always 0-9.
    rucDv: smallint('ruc_dv').notNull(),
    // dNomEmi (MT §D2, D105): 4-255 chars.
    legalName: varchar('legal_name', { length: 255 }).notNull(),
    // dNomFanEmi (MT §D2, D106): 4-255 chars, optional.
    tradeName: varchar('trade_name', { length: 255 }),
    taxpayerType: fiscalTaxpayerType('taxpayer_type').notNull(),
    // cTipReg (MT §D2, D104): 1-2 digits, optional. Closed code list
    // ("Tabla 1 – Tipo de Régimen") not present in docs/referencia/dnit,
    // so only the format is enforced here.
    regimeCode: varchar('regime_code', { length: 2 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check('tenant_fiscal_profiles_ruc_base_format', sql`${table.rucBase} ~ '^[0-9]{3,8}$'`),
    check('tenant_fiscal_profiles_ruc_dv_range', sql`${table.rucDv} BETWEEN 0 AND 9`),
    check(
      'tenant_fiscal_profiles_regime_code_format',
      sql`${table.regimeCode} IS NULL OR ${table.regimeCode} ~ '^[0-9]{1,2}$'`,
    ),
  ],
);

/**
 * Economic activities declared for a tenant's fiscal profile (gActEco, MT
 * §D2.1, D130-D132): 1-9 entries per emitter, enforced by the domain layer
 * (`createFiscalProfile`), not by a DB-level count constraint.
 */
export const tenantFiscalEconomicActivities = pgTable(
  'tenant_fiscal_economic_activities',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    // cActEco (MT §D2.1, D131): 1-8 alphanumeric chars. Closed code list
    // ("Tabla 3 – Actividades Económicas") not present in docs/referencia/dnit,
    // so only the format is enforced here.
    code: varchar('code', { length: 8 }).notNull(),
    // dDesActEco (MT §D2.1, D132): 1-300 chars.
    description: varchar('description', { length: 300 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('tenant_fiscal_economic_activities_tenant_id_idx').on(table.tenantId),
    uniqueIndex('tenant_fiscal_economic_activities_tenant_code_idx').on(table.tenantId, table.code),
    check(
      'tenant_fiscal_economic_activities_code_format',
      sql`${table.code} ~ '^[A-Za-z0-9]{1,8}$'`,
    ),
  ],
);

/**
 * Every table that carries a `tenant_id` column and MUST be covered by
 * `FORCE ROW LEVEL SECURITY` plus a tenant-isolation policy. The
 * `rls-coverage.spec.ts` drift check discovers these tables from the
 * catalog and asserts this list matches it.
 */
export const TENANT_TABLES = [
  'api_keys',
  'tenant_fiscal_economic_activities',
  'tenant_fiscal_profiles',
  'tenant_probe',
] as const;
