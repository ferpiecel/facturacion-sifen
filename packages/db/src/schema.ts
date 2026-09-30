import { sql } from 'drizzle-orm';
import {
  check,
  date,
  foreignKey,
  index,
  integer,
  primaryKey,
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
 * Establishments (dEst, MT §D2 D107 / XSD tdEst): tenant-scoped physical
 * locations that issue documents. `code` is the 3-digit dEst (never
 * "000"); `departmentCode`/`districtCode`/`cityCode` mirror cDepEmi/
 * cDisEmi/cCiuEmi (HU-E2-02). The closed code lists ("Tabla 2 –
 * Departamentos" etc.) aren't in docs/referencia/dnit, so only the format
 * is enforced here, same approach as `regimeCode`/`code` above.
 */
export const tenantEstablishments = pgTable(
  'tenant_establishments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    // dEst (MT §D2, D107 / XSD tdEst): 3 digits, not all zeros.
    code: varchar('code', { length: 3 }).notNull(),
    // dDirEmi (MT §D2, D109 / XSD tdDirec): up to 255 chars.
    address: varchar('address', { length: 255 }).notNull(),
    // dNumCas (MT §D2, D110 / XSD tdNumCas): 1-6 chars, "0" when the
    // property has no numbering. Always required (domain: houseNumber).
    houseNumber: varchar('house_number', { length: 6 }).notNull(),
    // dCompDir1 (MT §D2, D110b): optional, same length class as dDirEmi.
    addressComplement1: varchar('address_complement_1', { length: 255 }),
    // dCompDir2 (MT §D2, D110c): optional, same length class as dDirEmi.
    addressComplement2: varchar('address_complement_2', { length: 255 }),
    // cDepEmi (MT §D2, D111 / XSD tDepartamentos): 1-2 digits. Closed code
    // list ("Tabla 2 – Departamentos") not present in docs/referencia/dnit.
    departmentCode: varchar('department_code', { length: 2 }).notNull(),
    // cDisEmi (MT §D2, D113 / XSD tcDisEmi): 1-4 digits, occurrence 0-1.
    // Nullable: the domain allows omitting it (see the pairing CHECK below).
    districtCode: varchar('district_code', { length: 4 }),
    // dDesDisEmi (MT §D2, D114): required together with cDisEmi, same
    // length class as dDesCiuEmi below.
    districtDescription: varchar('district_description', { length: 30 }),
    // cCiuEmi (MT §D2, D115 / XSD tcCiuEmi): 1-5 digits.
    cityCode: varchar('city_code', { length: 5 }).notNull(),
    // dDesCiuEmi (MT §D2, D116): 1-30 chars, always required (domain:
    // cityDescription).
    cityDescription: varchar('city_description', { length: 30 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('tenant_establishments_tenant_id_idx').on(table.tenantId),
    uniqueIndex('tenant_establishments_tenant_code_idx').on(table.tenantId, table.code),
    // Composite target for tenant_expedition_points' (tenant_id, establishment_id)
    // FK, so a child row can never point at another tenant's establishment.
    uniqueIndex('tenant_establishments_tenant_id_id_idx').on(table.tenantId, table.id),
    check(
      'tenant_establishments_code_format',
      sql`${table.code} ~ '^[0-9]{3}$' AND ${table.code} <> '000'`,
    ),
    check(
      'tenant_establishments_department_code_format',
      sql`${table.departmentCode} ~ '^[0-9]{1,2}$'`,
    ),
    check(
      'tenant_establishments_district_code_format',
      sql`${table.districtCode} ~ '^[0-9]{1,4}$'`,
    ),
    // Mirrors the domain's pairing rule (createEstablishment): cDisEmi and
    // dDesDisEmi must both be present or both be absent.
    check(
      'tenant_establishments_district_code_description_pairing',
      sql`(${table.districtCode} IS NULL) = (${table.districtDescription} IS NULL)`,
    ),
    check('tenant_establishments_city_code_format', sql`${table.cityCode} ~ '^[0-9]{1,5}$'`),
  ],
);

/**
 * Expedition points (dPunExp, MT §C006 / XSD tdPunExp): tenant-scoped,
 * always attached to one establishment (HU-E2-02). The FK is composite on
 * `(tenant_id, establishment_id)` against `tenant_establishments(tenant_id,
 * id)` so a row can never reference another tenant's establishment even if
 * an attacker guesses a valid `establishment_id` (defense in depth on top
 * of RLS).
 */
export const tenantExpeditionPoints = pgTable(
  'tenant_expedition_points',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    establishmentId: uuid('establishment_id').notNull(),
    // dPunExp (MT §C006 / XSD tdPunExp): 3 digits, not all zeros.
    code: varchar('code', { length: 3 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('tenant_expedition_points_tenant_id_idx').on(table.tenantId),
    index('tenant_expedition_points_establishment_id_idx').on(table.establishmentId),
    uniqueIndex('tenant_expedition_points_tenant_establishment_code_idx').on(
      table.tenantId,
      table.establishmentId,
      table.code,
    ),
    // Composite target for tenant_document_sequences' point FK.
    uniqueIndex('tenant_expedition_points_tenant_establishment_id_idx').on(
      table.tenantId,
      table.establishmentId,
      table.id,
    ),
    foreignKey({
      columns: [table.tenantId, table.establishmentId],
      foreignColumns: [tenantEstablishments.tenantId, tenantEstablishments.id],
      name: 'tenant_expedition_points_tenant_establishment_fk',
    }),
    check(
      'tenant_expedition_points_code_format',
      sql`${table.code} ~ '^[0-9]{3}$' AND ${table.code} <> '000'`,
    ),
  ],
);

/**
 * Timbrados (dNumTim, MT §C004 / XSD tdNumTim): tenant-scoped authorization
 * numbers issued by SET to the emitter (HU-E2-02). Per the MT a timbrado
 * covers the issuer (RUC), not a single establishment/expedition point —
 * SIFEN's own habilitación (SGTM) links a timbrado to up to one
 * establishment and 3 points (plan-desarrollo-v1.1.md §"Timbrado"), but
 * that linkage belongs to a future numbering/habilitación table
 * (`numeracion_secuencial` in the plan), not this one.
 */
export const tenantTimbrados = pgTable(
  'tenant_timbrados',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    // dNumTim (MT §C004 / XSD tdNumTim): 8 digits, not all zeros.
    number: varchar('number', { length: 8 }).notNull(),
    // dFeIniT (MT §C008 / XSD tdFeIniT): minInclusive 2018-05-01, enforced
    // by the domain layer (`createTimbrado`), not by a DB-level check.
    validFrom: date('valid_from').notNull(),
    // dFeFinT (MT §C008 / XSD tdFeFinT): optional, must not precede validFrom.
    validTo: date('valid_to'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('tenant_timbrados_tenant_id_idx').on(table.tenantId),
    uniqueIndex('tenant_timbrados_tenant_number_idx').on(table.tenantId, table.number),
    // Composite target for tenant_document_sequences' timbrado FK.
    uniqueIndex('tenant_timbrados_tenant_id_id_idx').on(table.tenantId, table.id),
    check(
      'tenant_timbrados_number_format',
      sql`${table.number} ~ '^[0-9]{8}$' AND ${table.number} <> '00000000'`,
    ),
    check(
      'tenant_timbrados_valid_to_after_valid_from',
      sql`${table.validTo} IS NULL OR ${table.validTo} >= ${table.validFrom}`,
    ),
  ],
);

/**
 * Last assigned `dNumDoc` (MT v150 C005, 7 digits: 0000001..9999999) per
 * (environment, timbrado, establishment, expedition point, document type)
 * for a tenant (HU-E4-01). Only advanced by `nextDocumentNumber` inside the
 * caller's tenant transaction. `document_type` is the `iTiDE` code (C002).
 */
export const tenantDocumentSequences = pgTable(
  'tenant_document_sequences',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    environment: varchar('environment', { length: 16 }).$type<'test' | 'production'>().notNull(),
    timbradoId: uuid('timbrado_id').notNull(),
    establishmentId: uuid('establishment_id').notNull(),
    expeditionPointId: uuid('expedition_point_id').notNull(),
    documentType: smallint('document_type').notNull(),
    lastNumber: integer('last_number').notNull().default(0),
  },
  (table) => [
    primaryKey({
      columns: [
        table.tenantId,
        table.environment,
        table.timbradoId,
        table.establishmentId,
        table.expeditionPointId,
        table.documentType,
      ],
      name: 'tenant_document_sequences_pkey',
    }),
    foreignKey({
      columns: [table.tenantId, table.timbradoId],
      foreignColumns: [tenantTimbrados.tenantId, tenantTimbrados.id],
      name: 'tenant_document_sequences_tenant_timbrado_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.establishmentId, table.expeditionPointId],
      foreignColumns: [
        tenantExpeditionPoints.tenantId,
        tenantExpeditionPoints.establishmentId,
        tenantExpeditionPoints.id,
      ],
      name: 'tenant_document_sequences_tenant_point_fk',
    }),
    check(
      'tenant_document_sequences_environment_valid',
      sql`${table.environment} IN ('test', 'production')`,
    ),
    check(
      'tenant_document_sequences_last_number_range',
      sql`${table.lastNumber} BETWEEN 0 AND 9999999`,
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
  'tenant_document_sequences',
  'tenant_establishments',
  'tenant_expedition_points',
  'tenant_fiscal_economic_activities',
  'tenant_fiscal_profiles',
  'tenant_probe',
  'tenant_timbrados',
] as const;
