import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  char,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  primaryKey,
  pgEnum,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
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
 * `tenants.environment`: which SIFEN environment a tenant's documents are
 * emitted for (HU-E2-04, ADR-0012). Lives on `tenants` rather than
 * `tenant_fiscal_profiles` because it is a platform-level identity attribute
 * that must exist for every tenant from creation (default `'test'`, fail
 * safe) independently of whether a fiscal profile has been configured yet,
 * and because it governs behavior outside fiscal data too (which API keys a
 * tenant may use, `SIFEN_ENVIRONMENT` at the deployment level).
 */
export const tenantEnvironment = pgEnum('tenant_environment', ['test', 'production']);

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
    // Defaults to 'test' (fail safe): a tenant must be switched to
    // 'production' explicitly (HU-E2-04).
    environment: tenantEnvironment('environment').notNull().default('test'),
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

/** `tenant_memberships.role`: what a portal user may do inside one tenant (PRD A4, HU-E1-07). */
export const portalRole = pgEnum('portal_role', ['owner', 'admin', 'emisor', 'lector']);

/**
 * Portal users (HU-E1-07): a global identity, deliberately without `tenant_id`
 * because one person (typically an accountant) can belong to several tenants.
 * `password_hash` is an Argon2id PHC string hashed by the application. RLS is
 * enabled and forced and `app_user` has no grant, so request code can never
 * read it; pre-authentication lookups use a dedicated resolver role in a later
 * slice (same pattern as `api_keys`, migration 0003). Emails are stored lower-case.
 */
export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: varchar('email', { length: 254 }).notNull(),
    passwordHash: text('password_hash').notNull(),
    displayName: varchar('display_name', { length: 255 }).notNull(),
    disabledAt: timestamp('disabled_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('users_email_key').on(table.email),
    check(
      'users_email_lowercase',
      sql`${table.email} = lower(${table.email}) AND position('@' in ${table.email}) > 1`,
    ),
    check('users_password_hash_argon2id', sql`${table.passwordHash} LIKE '$argon2id$%'`),
  ],
);

/**
 * Which tenants a user belongs to and with which role (HU-E1-07). Tenant-scoped
 * under the standard `tenant_isolation` policy. A membership is never moved to
 * another tenant or user; only its role changes.
 */
export const tenantMemberships = pgTable(
  'tenant_memberships',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    role: portalRole('role').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('tenant_memberships_tenant_id_user_id_key').on(table.tenantId, table.userId),
    index('tenant_memberships_user_id_idx').on(table.userId),
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
    // dTelEmi (XSD tdTel, gEmis, required in the DE): 6-15 chars. Nullable here only because
    // establishments created before HU-E6-02 have none; signing refuses a missing one.
    phone: varchar('phone', { length: 15 }),
    // dEmailE (XSD tEmail, gEmis, required in the DE): same nullability reason as `phone`.
    email: varchar('email', { length: 255 }),
    // dDenSuc (XSD gEmis, minOccurs 0): commercial name of the branch, 1-30 chars.
    commercialName: varchar('commercial_name', { length: 30 }),
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
    check(
      'tenant_establishments_phone_length',
      sql`char_length(${table.phone}) BETWEEN 6 AND 15 AND ${table.phone} !~ '^[[:space:]]*$' AND ${table.phone} !~ '[[:cntrl:]]'`,
    ),
    // XSD tEmail pattern (DE_Types_v150.xsd), anchored; written without backslashes (a sql`` template
    // would swallow them): `.` and `-` live inside bracket expressions.
    check(
      'tenant_establishments_email_format',
      sql`${table.email} ~ '^[0-9a-zA-Z]([0-9a-zA-Z._-])*@([0-9a-zA-Z][0-9a-zA-Z_-]*[.])+[a-zA-Z]{2,9}$'`,
    ),
    check(
      'tenant_establishments_commercial_name_length',
      sql`char_length(${table.commercialName}) >= 1 AND ${table.commercialName} !~ '^[[:space:]]*$'`,
    ),
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

/** `audit_log.actor_type`: who performed the audited write. */
export const auditActorType = pgEnum('audit_actor_type', ['api_key', 'user', 'operator', 'system']);

/**
 * Append-only audit trail (HU-E13-01, RF-16, RNF-08). `before`/`after` are
 * stored already redacted (the API's `redact`). UPDATE/DELETE/TRUNCATE are
 * rejected by a trigger (migration 0014) and app_user only has
 * SELECT/INSERT. `seq`, `prev_hash` and `hash` form a per-tenant SHA-256
 * chain (HU-E13-02): a BEFORE INSERT trigger (migration 0018) overwrites them,
 * so values supplied by the app are ignored.
 */
export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    actorType: auditActorType('actor_type').notNull(),
    actorId: varchar('actor_id', { length: 255 }).notNull(),
    action: varchar('action', { length: 100 }).notNull(),
    entityType: varchar('entity_type', { length: 100 }).notNull(),
    entityId: varchar('entity_id', { length: 255 }).notNull(),
    before: jsonb('before'),
    after: jsonb('after'),
    seq: bigint('seq', { mode: 'number' }).notNull().default(0),
    prevHash: text('prev_hash').notNull().default(''),
    hash: text('hash').notNull().default(''),
  },
  (table) => [
    unique('audit_log_tenant_seq_unique').on(table.tenantId, table.seq),
    index('audit_log_tenant_occurred_at_idx').on(table.tenantId, table.occurredAt),
    check('audit_log_action_not_blank', sql`btrim(${table.action}) <> ''`),
    check('audit_log_entity_id_not_blank', sql`btrim(${table.entityId}) <> ''`),
  ],
);

/**
 * Last `dId` (SIFEN request id, numeric 1..15 digits) issued per tenant and
 * environment (HU-E4-03). Only advanced by `nextRequestId` inside the
 * caller's tenant transaction.
 */
export const tenantRequestSequences = pgTable(
  'tenant_request_sequences',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    environment: tenantEnvironment('environment').notNull(),
    lastValue: bigint('last_value', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
  },
  (table) => [
    primaryKey({
      columns: [table.tenantId, table.environment],
      name: 'tenant_request_sequences_pkey',
    }),
    check(
      'tenant_request_sequences_last_value_range',
      sql`${table.lastValue} BETWEEN 0 AND 999999999999999`,
    ),
  ],
);

/**
 * Envelope-encrypted CSC (ADR-0009, HU-E2-03), up to 2 per tenant and
 * environment (`tenant_cscs_enforce_limit` trigger). The CSC never exists in
 * clear in the database: only the `EnvelopeCipher` output is stored in `sealed`.
 */
export const tenantCscs = pgTable(
  'tenant_cscs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    environment: tenantEnvironment('environment').notNull(),
    idCsc: char('id_csc', { length: 4 }).notNull(),
    /** Race-free limit: only slots 1 and 2 exist, each unique per tenant and environment. */
    slot: smallint('slot').notNull(),
    sealed: jsonb('sealed').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('tenant_cscs_tenant_environment_id_csc_key').on(
      table.tenantId,
      table.environment,
      table.idCsc,
    ),
    unique('tenant_cscs_tenant_environment_slot_key').on(
      table.tenantId,
      table.environment,
      table.slot,
    ),
    check('tenant_cscs_slot_range', sql`${table.slot} IN (1, 2)`),
    check('tenant_cscs_id_csc_format', sql`${table.idCsc} ~ '^[0-9]{4}$'`),
  ],
);

export const CERTIFICATE_STATUSES = ['active', 'revoked'] as const;

/**
 * A tenant's `.p12`, sealed with the custody envelope (ADR-0009, HU-E3-01). Only the sealed
 * blob holds the key; the other columns are public facts read from the certificate. At most one
 * `active` certificate per tenant and environment; rotation revokes the old one. Never deleted.
 */
export const tenantCertificates = pgTable(
  'tenant_certificates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    environment: tenantEnvironment('environment').notNull(),
    /** `EnvelopeCipher` output for `{ p12, password }`, bound to this row's identity (AAD). */
    sealed: jsonb('sealed').notNull(),
    /** sha-256 hex of the certificate's DER encoding. */
    fingerprint: char('fingerprint', { length: 64 }).notNull(),
    /** Formatted RUC (`base-dv`) read from the certificate subject. */
    subjectRuc: varchar('subject_ruc', { length: 12 }).notNull(),
    notBefore: timestamp('not_before', { withTimezone: true }).notNull(),
    notAfter: timestamp('not_after', { withTimezone: true }).notNull(),
    status: varchar('status', { length: 16 }).notNull().default('active'),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('tenant_certificates_one_active_idx')
      .on(table.tenantId, table.environment)
      .where(sql`${table.status} = 'active'`),
    unique('tenant_certificates_tenant_environment_fingerprint_key').on(
      table.tenantId,
      table.environment,
      table.fingerprint,
    ),
    check('tenant_certificates_fingerprint_format', sql`${table.fingerprint} ~ '^[0-9a-f]{64}$'`),
    check(
      'tenant_certificates_status_valid',
      sql`${table.status} IN (${sql.raw(CERTIFICATE_STATUSES.map((s) => `'${s}'`).join(', '))})`,
    ),
    check(
      'tenant_certificates_revoked_pair',
      sql`(${table.status} = 'revoked') = (${table.revokedAt} IS NOT NULL)`,
    ),
    check('tenant_certificates_validity_order', sql`${table.notBefore} < ${table.notAfter}`),
  ],
);

/** Lifecycle events a webhook can carry; mirrors the API's `WEBHOOK_EVENT_TYPES` (parity spec in apps/api). */
export const WEBHOOK_EVENT_TYPES = [
  'document.created',
  'document.signed',
  'document.submitted',
  'document.approved',
  'document.approved_with_observations',
  'document.rejected',
  'document.cancelled',
  'document.number_voided',
  'document.transmission_deadline_warning',
  'document.notification.delivered',
  'document.notification.failed',
] as const;

/**
 * `pending` = never attempted, `failed` = attempted and a retry is scheduled, `delivered`, and
 * `dead` = retries exhausted (the DLQ; it can be replayed back to `pending`).
 */
export const WEBHOOK_DELIVERY_STATUSES = ['pending', 'failed', 'delivered', 'dead'] as const;

const sqlList = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(', '));

/**
 * Where a tenant receives its lifecycle events (HU-E11-01). The HMAC signing secret is stored only
 * as an `EnvelopeCipher` blob (`sealed`), never in clear. A rotation keeps the old secret in
 * `previous_sealed` until `previous_expires_at` so receivers can switch without dropping events.
 */
export const webhookEndpoints = pgTable(
  'webhook_endpoints',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    /** HTTPS only, no userinfo; the SSRF checks run at delivery time (DNS), not here. */
    url: text('url').notNull(),
    /** Subscribed event types; empty = every event. */
    events: text('events')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    sealed: jsonb('sealed').notNull(),
    /** Bound into the sealed secret's AAD; bumped on every rotation. */
    secretVersion: integer('secret_version').notNull().default(1),
    previousSealed: jsonb('previous_sealed'),
    previousExpiresAt: timestamp('previous_expires_at', { withTimezone: true }),
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('webhook_endpoints_tenant_id_key').on(table.tenantId, table.id),
    // Lowercase `https://` only (the scheme is case-insensitive in RFC 3986, but accepting one
    // spelling keeps the check, the SSRF guard and the docs in agreement); non-empty host, no
    // userinfo, optional port, no whitespace. DNS and address checks belong to the dispatcher.
    check(
      'webhook_endpoints_url_https',
      sql`${table.url} ~ '^https://[^/?#:@[:space:]]+(:[0-9]{1,5})?([/?#][^[:space:]]*)?$' AND length(${table.url}) <= 2048`,
    ),
    check(
      'webhook_endpoints_events_valid',
      sql`${table.events} <@ ARRAY[${sqlList(WEBHOOK_EVENT_TYPES)}]::text[]`,
    ),
    check('webhook_endpoints_events_unique', sql`webhook_events_unique(${table.events})`),
    check(
      'webhook_endpoints_previous_pair',
      sql`(${table.previousSealed} IS NULL) = (${table.previousExpiresAt} IS NULL)`,
    ),
  ],
);

/**
 * One event to one endpoint: the retry queue (`next_attempt_at`) and the delivery history in a
 * single row. Enqueued by the outbox in the same transaction as the document change; `payload`
 * is the full event envelope. Never deleted.
 */
export const webhookDeliveries = pgTable(
  'webhook_deliveries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    endpointId: uuid('endpoint_id').notNull(),
    eventId: varchar('event_id', { length: 68 }).notNull(),
    eventType: varchar('event_type', { length: 48 }).notNull(),
    payload: jsonb('payload').notNull(),
    status: varchar('status', { length: 16 }).notNull().default('pending'),
    attemptCount: integer('attempt_count').notNull().default(0),
    /** Anchor of the 24 h retry window. */
    firstAttemptAt: timestamp('first_attempt_at', { withTimezone: true }),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }),
    lastAttemptAt: timestamp('last_attempt_at', { withTimezone: true }),
    lastStatusCode: smallint('last_status_code'),
    /** Short, secret-free reason of the last failure (timeout, blocked address, ...). */
    lastError: varchar('last_error', { length: 500 }),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      name: 'webhook_deliveries_tenant_endpoint_fk',
      columns: [table.tenantId, table.endpointId],
      foreignColumns: [webhookEndpoints.tenantId, webhookEndpoints.id],
    }),
    unique('webhook_deliveries_endpoint_event_key').on(table.endpointId, table.eventId),
    index('webhook_deliveries_due_idx')
      .on(table.nextAttemptAt)
      .where(sql`${table.status} IN ('pending', 'failed')`),
    check(
      'webhook_deliveries_status_valid',
      sql`${table.status} IN (${sqlList(WEBHOOK_DELIVERY_STATUSES)})`,
    ),
    check(
      'webhook_deliveries_event_type_valid',
      sql`${table.eventType} IN (${sqlList(WEBHOOK_EVENT_TYPES)})`,
    ),
    check(
      'webhook_deliveries_next_attempt_pair',
      sql`(${table.status} IN ('pending', 'failed')) = (${table.nextAttemptAt} IS NOT NULL)`,
    ),
    check(
      'webhook_deliveries_delivered_pair',
      sql`(${table.status} = 'delivered') = (${table.deliveredAt} IS NOT NULL)`,
    ),
    check('webhook_deliveries_attempts_nonneg', sql`${table.attemptCount} >= 0`),
    check(
      'webhook_deliveries_status_code_range',
      sql`${table.lastStatusCode} IS NULL OR ${table.lastStatusCode} BETWEEN 100 AND 599`,
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
    environment: tenantEnvironment('environment').notNull(),
    timbradoId: uuid('timbrado_id').notNull(),
    establishmentId: uuid('establishment_id').notNull(),
    expeditionPointId: uuid('expedition_point_id').notNull(),
    documentType: smallint('document_type').notNull(),
    /** `dSerieNum`; '' while numbering runs without a series (rule 1110). */
    series: varchar('series', { length: 2 }).notNull().default(''),
    seriesStartedAt: timestamp('series_started_at', { withTimezone: true }).notNull().defaultNow(),
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
        table.series,
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
      'tenant_document_sequences_document_type_range',
      sql`${table.documentType} BETWEEN 1 AND 8`,
    ),
    check(
      'tenant_document_sequences_series_format',
      sql`${table.series} = '' OR ${table.series} ~ '^[A-Z]{2}$'`,
    ),
    check(
      'tenant_document_sequences_last_number_range',
      sql`${table.lastNumber} BETWEEN 0 AND 9999999`,
    ),
  ],
);

/** Lifecycle states of a document (plan v1.1 §8.0); `accepted` = validated and numbered, not yet signed. */
export const DOCUMENT_STATUSES = [
  'accepted',
  'signed',
  'queued',
  'submitted',
  'approved',
  'approved_with_observations',
  'rejected',
  'corrected',
  'number_voided',
  'cancelled',
] as const;

/**
 * Electronic documents accepted through `POST /v1/documents` (HU-E5-01). The
 * identity columns (CDC, numbering, security code, payload) never change; only
 * `status` and `updated_at` do. Rows are never deleted.
 */
export const documents = pgTable(
  'documents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    environment: tenantEnvironment('environment').notNull(),
    /** 44-digit CDC. */
    cdc: char('cdc', { length: 44 }).notNull(),
    /** `iTiDE` (C002). */
    documentType: smallint('document_type').notNull(),
    timbradoId: uuid('timbrado_id').notNull(),
    establishmentId: uuid('establishment_id').notNull(),
    expeditionPointId: uuid('expedition_point_id').notNull(),
    /** `dSerieNum`; '' while numbering runs without a series. */
    series: varchar('series', { length: 2 }).notNull().default(''),
    /** `dNumDoc`. */
    number: integer('number').notNull(),
    /** `dCodSeg`, random, never derived from `dNumDoc`. */
    securityCode: char('security_code', { length: 9 }).notNull(),
    status: varchar('status', { length: 32 }).notNull().default('accepted'),
    receiverRuc: varchar('receiver_ruc', { length: 15 }),
    issuedAt: timestamp('issued_at', { withTimezone: true }).notNull(),
    totalAmount: numeric('total_amount', { precision: 23, scale: 8 }).notNull(),
    currency: char('currency', { length: 3 }).notNull().default('PYG'),
    /** The request body as received. */
    payload: jsonb('payload').notNull(),
    /** Final signed DE XML (signature and QR included), set once when the document is signed. */
    signedXml: text('signed_xml'),
    /** The `dFecFirma` of that signature, as an instant. */
    signedAt: timestamp('signed_at', { withTimezone: true }),
    /** Times the lote carrying this document was refused with 0301; drives the re-queue cap (HU-E6-02). */
    transmissionAttempts: integer('transmission_attempts').notNull().default(0),
    /**
     * When the recovery queued the document again after SIFEN kept answering 0420 past the window
     * (HU-E6-04): write-once, and the only door of the `submitted -> queued` transition.
     */
    resentAt: timestamp('resent_at', { withTimezone: true }),
    /** Not eligible for a new lote before this instant (backoff after 0301). */
    nextTransmissionAt: timestamp('next_transmission_at', { withTimezone: true }),
    /**
     * Why the pipeline stopped working on this document until an operator clears it: a plain
     * code (never free text, never a secret), e.g. `signing:SigningDataIncompleteError`.
     */
    transmissionHold: varchar('transmission_hold', { length: 64 }),
    /** SIFEN's `dCodRes`/`dMsgRes` pairs for the final result, as `[{code, message}]` (HU-E6-03). */
    sifenMessages: jsonb('sifen_messages'),
    /**
     * `Idempotency-Key` of the request that created the document (HU-E5-02),
     * unique per tenant. Null only for rows that predate the story.
     */
    idempotencyKey: varchar('idempotency_key', { length: 255 }),
    /** sha-256 hex of the canonical JSON of the validated body, to detect a reused key. */
    requestHash: char('request_hash', { length: 64 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('documents_tenant_environment_cdc_key').on(table.tenantId, table.environment, table.cdc),
    unique('documents_sequence_number_key').on(
      table.tenantId,
      table.environment,
      table.timbradoId,
      table.establishmentId,
      table.expeditionPointId,
      table.documentType,
      table.series,
      table.number,
    ),
    foreignKey({
      columns: [table.tenantId, table.timbradoId],
      foreignColumns: [tenantTimbrados.tenantId, tenantTimbrados.id],
      name: 'documents_tenant_timbrado_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.establishmentId, table.expeditionPointId],
      foreignColumns: [
        tenantExpeditionPoints.tenantId,
        tenantExpeditionPoints.establishmentId,
        tenantExpeditionPoints.id,
      ],
      name: 'documents_tenant_point_fk',
    }),
    unique('documents_tenant_idempotency_key_key').on(table.tenantId, table.idempotencyKey),
    check('documents_transmission_attempts_range', sql`${table.transmissionAttempts} >= 0`),
    check(
      'documents_transmission_hold_format',
      sql`${table.transmissionHold} ~ '^[A-Za-z0-9:_-]{1,64}$'`,
    ),
    check('documents_signed_pair', sql`(${table.signedXml} IS NULL) = (${table.signedAt} IS NULL)`),
    check(
      'documents_idempotency_pair',
      sql`(${table.idempotencyKey} IS NULL) = (${table.requestHash} IS NULL)`,
    ),
    // 1-255 printable ASCII without spaces.
    check('documents_idempotency_key_format', sql`${table.idempotencyKey} ~ '^[!-~]{1,255}$'`),
    check('documents_idempotency_hash_format', sql`${table.requestHash} ~ '^[0-9a-f]{64}$'`),
    check('documents_cdc_format', sql`${table.cdc} ~ '^[0-9]{44}$'`),
    check('documents_security_code_format', sql`${table.securityCode} ~ '^[0-9]{9}$'`),
    check('documents_number_range', sql`${table.number} BETWEEN 1 AND 9999999`),
    // iTiDE (C002) range: 1..8.
    check('documents_document_type_range', sql`${table.documentType} BETWEEN 1 AND 8`),
    unique('documents_tenant_id_key').on(table.tenantId, table.id),
    check('documents_series_format', sql`${table.series} = '' OR ${table.series} ~ '^[A-Z]{2}$'`),
    check(
      'documents_status_valid',
      sql`${table.status} IN (${sql.raw(DOCUMENT_STATUSES.map((s) => `'${s}'`).join(', '))})`,
    ),
  ],
);

export const LOTE_STATUSES = [
  'pending',
  'sending',
  'sent',
  'rejected',
  'unknown',
  /** 0362 received and every DE settled or flagged (HU-E6-03). */
  'processed',
  /** 0364, 0360 or the 48 h window lapsed: HU-E6-04 queries each CDC. */
  'recovery',
] as const;

/**
 * A lote of DEs sent to SIFEN through `siRecepLoteDE` (HU-E6-02). `sending` is
 * set before the call and never retried; a lote stuck there is recovered as
 * `unknown` by querying SIFEN (HU-E6-04). Rows are never deleted.
 */
export const lotes = pgTable(
  'lotes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    environment: tenantEnvironment('environment').notNull(),
    /** `iTiDE`: a lote carries a single document type. */
    documentType: smallint('document_type').notNull(),
    status: varchar('status', { length: 16 }).notNull().default('pending'),
    /** `dProtConsLote`, returned with 0300. */
    sifenProtocol: varchar('sifen_protocol', { length: 64 }),
    /** `dCodRes` of the `siRecepLoteDE` answer, when there was one. */
    responseCode: varchar('response_code', { length: 8 }),
    /** `dMsgRes`, or why the outcome is unknown. */
    responseMessage: text('response_message'),
    /**
     * When the send was attempted (`pending -> sending`, HU-E6-04). Unlike `sent_at` it exists for a
     * send that got no answer, and it is when SIFEN may have started processing: the 48 h window of the
     * recovery counts from it. Null for lotes that predate it.
     */
    sendAttemptedAt: timestamp('send_attempted_at', { withTimezone: true }),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    /** First lote query: `sent_at` + 10 min. */
    nextPollAt: timestamp('next_poll_at', { withTimezone: true }),
    /** Lote queries stop being valid 48 h after sending (0364). */
    pollDeadlineAt: timestamp('poll_deadline_at', { withTimezone: true }),
    /** When `siResultLoteDE` was last queried (HU-E6-03). */
    lastPolledAt: timestamp('last_polled_at', { withTimezone: true }),
    /** Why the lote is still `sent` after a query, or why it went to `recovery`. */
    lastPollMessage: text('last_poll_message'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('lotes_tenant_id_key').on(table.tenantId, table.id),
    check('lotes_document_type_range', sql`${table.documentType} BETWEEN 1 AND 8`),
    check(
      'lotes_status_valid',
      sql`${table.status} IN (${sql.raw(LOTE_STATUSES.map((s) => `'${s}'`).join(', '))})`,
    ),
  ],
);

/**
 * The documents a lote carries. A document may reappear in a later lote once
 * the earlier one was rejected, so uniqueness is per (lote, document) only; the
 * "no CDC in two lotes in process" rule stays in `LoteBuilder`.
 */
export const loteDocuments = pgTable(
  'lote_documents',
  {
    loteId: uuid('lote_id').notNull(),
    documentId: uuid('document_id').notNull(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
  },
  (table) => [
    primaryKey({ columns: [table.loteId, table.documentId] }),
    index('lote_documents_document_id_idx').on(table.documentId),
    foreignKey({
      columns: [table.tenantId, table.loteId],
      foreignColumns: [lotes.tenantId, lotes.id],
      name: 'lote_documents_tenant_lote_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.documentId],
      foreignColumns: [documents.tenantId, documents.id],
      name: 'lote_documents_tenant_document_fk',
    }),
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
  'audit_log',
  'documents',
  'lote_documents',
  'lotes',
  'tenant_document_sequences',
  'tenant_establishments',
  'tenant_expedition_points',
  'tenant_fiscal_economic_activities',
  'tenant_fiscal_profiles',
  'tenant_certificates',
  'tenant_cscs',
  'tenant_memberships',
  'tenant_probe',
  'tenant_request_sequences',
  'tenant_timbrados',
  'webhook_deliveries',
  'webhook_endpoints',
] as const;
