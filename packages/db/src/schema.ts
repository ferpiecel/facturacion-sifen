import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
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
 * (`tenants.partner_id`). The partner's read-only view of its tenants is HU-E1-06
 * (`partner_viewer`, migration 0044); this table has no `GRANT` to `app_user` or
 * `partner_viewer`, so only the operator's own connection reads or writes it.
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
    /** Sessions created before this instant are dead (revoke-all stamps it), whatever their rows say. */
    sessionsValidAfter: timestamp('sessions_valid_after', { withTimezone: true })
      .notNull()
      .default(sql`'epoch'`),
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
 * TOTP enrolment of a portal user (HU-E1-07): at most one per user. The secret exists only as an
 * `EnvelopeCipher` blob (`sealed`, AAD bound to the user). `last_used_step` is the replay guard;
 * `recovery_hashes` holds the SHA-256 of each unused one-time recovery code (at most 10). Like `users`
 * it is global: FORCE RLS, no `app_user` grant, only the operator role and the resolver of a later slice.
 */
export const userMfa = pgTable(
  'user_mfa',
  {
    userId: uuid('user_id')
      .primaryKey()
      .references(() => users.id),
    sealed: jsonb('sealed').notNull(),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    lastUsedStep: bigint('last_used_step', { mode: 'number' }),
    /** Consecutive second-factor attempts since the last success (HU-E1-07 hardening); only a success resets it. */
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),
    /** Set when the cap is reached: the user cannot verify MFA until an MFA reset removes this row. */
    mfaLockedAt: timestamp('mfa_locked_at', { withTimezone: true }),
    recoveryHashes: text('recovery_hashes')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check('user_mfa_recovery_hashes_valid', sql`user_mfa_hashes_valid(${table.recoveryHashes})`),
    check(
      'user_mfa_step_needs_confirmation',
      sql`${table.lastUsedStep} IS NULL OR ${table.confirmedAt} IS NOT NULL`,
    ),
  ],
);

/**
 * One generation of a portal session's token pair (HU-E1-07 S4). Tokens are opaque random values; only
 * their SHA-256 is stored. A refresh marks the row `rotated_at` and inserts the next generation in the
 * same `family_id`; presenting an already rotated refresh revokes the family. `mfa_verified_at` is null
 * for the pending session that exists between the password and the second factor. Global like `users`:
 * FORCE RLS, no `app_user` grant; every access goes through the SECURITY DEFINER functions of migration
 * 0039, owned by the narrow `session_resolver` role.
 */
export const userSessions = pgTable(
  'user_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    familyId: uuid('family_id').notNull(),
    accessHash: text('access_hash').notNull(),
    refreshHash: text('refresh_hash').notNull(),
    accessExpiresAt: timestamp('access_expires_at', { withTimezone: true }).notNull(),
    refreshExpiresAt: timestamp('refresh_expires_at', { withTimezone: true }).notNull(),
    /** Hard cap set at login and inherited by every generation: a refresh never extends past it. */
    absoluteExpiresAt: timestamp('absolute_expires_at', { withTimezone: true }).notNull(),
    activeTenantId: uuid('active_tenant_id').references(() => tenants.id),
    mfaVerifiedAt: timestamp('mfa_verified_at', { withTimezone: true }),
    rotatedAt: timestamp('rotated_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('user_sessions_access_hash_key').on(table.accessHash),
    unique('user_sessions_refresh_hash_key').on(table.refreshHash),
    index('user_sessions_user_id_idx').on(table.userId),
    index('user_sessions_family_id_idx').on(table.familyId),
    check(
      'user_sessions_hashes_sha256',
      sql`${table.accessHash} ~ '^[0-9a-f]{64}$' AND ${table.refreshHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      'user_sessions_refresh_outlives_access',
      sql`${table.refreshExpiresAt} >= ${table.accessExpiresAt}`,
    ),
  ],
);

/**
 * Failed-attempt counters (HU-E1-07 S4). `key` is the SHA-256 of what is being throttled (an email, an IP
 * or a user), so unknown emails are throttled exactly like real ones and nothing identifying is stored.
 * Written only through the `auth_throttle_*` functions of migration 0040.
 */
export const authThrottle = pgTable(
  'auth_throttle',
  {
    key: text('key').primaryKey(),
    failures: integer('failures').notNull().default(0),
    windowStartedAt: timestamp('window_started_at', { withTimezone: true }).notNull().defaultNow(),
    lockedUntil: timestamp('locked_until', { withTimezone: true }),
  },
  (table) => [check('auth_throttle_key_sha256', sql`${table.key} ~ '^[0-9a-f]{64}$'`)],
);

/**
 * Append-only trail of authentication events that happen before a tenant is active (D4): failed logins,
 * lockouts, MFA steps. `audit_log` is per tenant, so these live here; once a tenant is active its events
 * go to `audit_log`. UPDATE, DELETE and TRUNCATE are rejected by a trigger (migration 0040).
 */
export const authEvents = pgTable('auth_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  userId: uuid('user_id').references(() => users.id),
  /** SHA-256 of the email or IP involved when there is no (known) user. */
  subjectHash: text('subject_hash'),
  event: varchar('event', { length: 64 }).notNull(),
  detail: jsonb('detail')
    .notNull()
    .default(sql`'{}'::jsonb`),
});

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

/**
 * Which portal users manage which partner (HU-E1-06, ADR-0014). Global like `users`: FORCE RLS and no
 * `app_user` grant; membership is checked only through `user_in_partner` (migration 0044).
 */
export const partnerMemberships = pgTable(
  'partner_memberships',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    partnerId: uuid('partner_id')
      .notNull()
      .references(() => partners.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('partner_memberships_partner_id_user_id_key').on(table.partnerId, table.userId),
    index('partner_memberships_user_id_idx').on(table.userId),
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
    // HU-E6-06: opt-in to siRecepDE for single-DE lotes. SIFEN code 1264 (RUC not enabled) clears it.
    syncTransmission: boolean('sync_transmission').notNull().default(false),
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
  'document.nominated',
  'document.transmission_deadline_warning',
  'document.notification.delivered',
  'document.notification.failed',
  'certificate.expiring',
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
    /**
     * CDC of the document this one is associated to (`gCamDEAsoc/dCdCDERef`, HU-E7-01, ADR-0019): the FE
     * a credit note credits. Set on insert, immutable, never on an FE. That the target exists and is an FE
     * is a domain rule, not a foreign key: the CDC may belong to a document the platform did not issue.
     */
    associatedCdc: char('associated_cdc', { length: 44 }),
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
    /**
     * When SIFEN approved the document (HU-E8-02): the 48 h / 168 h cancellation windows count from it
     * (MT v150 11.6.1, 4009 and 4010). Write-once, only on an approved document, stamped by trigger 0056 when
     * the status becomes approved. NULL on rows approved before the column existed (refreshed lazily).
     */
    approvedAt: timestamp('approved_at', { withTimezone: true }),
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
    check('documents_associated_cdc_format', sql`${table.associatedCdc} ~ '^[0-9]{44}$'`),
    check('documents_associated_cdc_not_self', sql`${table.associatedCdc} <> ${table.cdc}`),
    // An FE (iTiDE 1) is never associated to another document.
    check(
      'documents_associated_cdc_not_invoice',
      sql`${table.documentType} <> 1 OR ${table.associatedCdc} IS NULL`,
    ),
    // Lookup of the credits of an FE (the 2417 sum), always scoped by tenant and environment.
    index('documents_associated_cdc_idx')
      .on(table.tenantId, table.environment, table.associatedCdc)
      .where(sql`${table.associatedCdc} IS NOT NULL`),
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

export const ISSUER_EVENT_KINDS = ['cancellation', 'voiding', 'nomination'] as const;
/** Events the tenant registers as the RECEIVER of someone else's DE/DTE (HU-E9-01); they target a CDC, not a document. */
export const RECEIVER_EVENT_KINDS = [
  'conformity',
  'disconformity',
  'unawareness',
  'receipt_notice',
] as const;
export const EVENT_KINDS = [...ISSUER_EVENT_KINDS, ...RECEIVER_EVENT_KINDS] as const;
export const ISSUER_EVENT_STATUSES = [
  'pending',
  'signed',
  'sending',
  'approved',
  'rejected',
  'unknown',
] as const;

export const DOCUMENT_EMAIL_STATUSES = ['pending', 'failed', 'sent', 'dead', 'skipped'] as const;

/**
 * Email outbox (HU-E11-02): the approved document (KuDE PDF + signed XML) owed to one receiver. One
 * row per (document, recipient) is the idempotency key; it is also the retry queue and the history.
 * The attachments are rendered at send time from the stored signed XML, so nothing sensitive is kept
 * here besides the recipient. `last_error` is a code, never provider text. Never deleted.
 */
export const documentEmails = pgTable(
  'document_emails',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    documentId: uuid('document_id').notNull(),
    recipient: varchar('recipient', { length: 254 }),
    status: varchar('status', { length: 16 }).notNull().default('pending'),
    attemptCount: integer('attempt_count').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }),
    lastAttemptAt: timestamp('last_attempt_at', { withTimezone: true }),
    lastError: varchar('last_error', { length: 64 }),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      name: 'document_emails_tenant_document_fk',
      columns: [table.tenantId, table.documentId],
      foreignColumns: [documents.tenantId, documents.id],
    }),
    unique('document_emails_document_key').on(table.tenantId, table.documentId),
    index('document_emails_due_idx')
      .on(table.nextAttemptAt)
      .where(sql`${table.status} IN ('pending', 'failed')`),
    check(
      'document_emails_status_valid',
      sql`${table.status} IN (${sqlList(DOCUMENT_EMAIL_STATUSES)})`,
    ),
    check(
      'document_emails_next_attempt_pair',
      sql`(${table.status} IN ('pending', 'failed')) = (${table.nextAttemptAt} IS NOT NULL)`,
    ),
    check(
      'document_emails_sent_pair',
      sql`(${table.status} = 'sent') = (${table.sentAt} IS NOT NULL)`,
    ),
    check('document_emails_attempts_nonneg', sql`${table.attemptCount} >= 0`),
    check(
      'document_emails_recipient_format',
      sql`${table.recipient} IS NULL OR (position('@' in ${table.recipient}) > 1 AND ${table.recipient} !~ '[[:space:]]')`,
    ),
    check(
      'document_emails_skipped_pair',
      sql`(${table.status} = 'skipped') = (${table.recipient} IS NULL)`,
    ),
  ],
);

/**
 * Events the issuer sends to `siRecepEvento` (HU-E8-04, ADR-0020): one table, typed by `kind`. A
 * cancellation or nomination points at a document; a voiding carries its number range. `event_id` is
 * the `rEve/@Id` SIFEN echoes in its answer (from the tenant's `dId` counter). The signed XML is
 * write-once; an answered event is final. A refused event may be requested again, an open one may not.
 * Rows are never deleted.
 */
export const issuerEvents = pgTable(
  'issuer_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    environment: tenantEnvironment('environment').notNull(),
    kind: varchar('kind', { length: 16 }).notNull(),
    /** `rEve/@Id`, 1 to 10 digits, unique per tenant and environment. */
    eventId: bigint('event_id', { mode: 'bigint' }).notNull(),
    documentId: uuid('document_id'),
    /** `{ timbrado, establishment, point, from, to, type, series? }` of a voiding. */
    voidRange: jsonb('void_range'),
    /** `mOtEve`, 5 to 500 characters; absent only on a conformity and a receipt notice, which carry none. */
    reason: text('reason'),
    /** CDC of the foreign DE/DTE a receiver event is about (HU-E9-01); null on issuer events. */
    targetCdc: char('target_cdc', { length: 44 }),
    /** Fields of the receiver event that its XML needs: dates, conformity type, total (HU-E9-01). */
    receiverData: jsonb('receiver_data'),
    /** The approved receiver event this one corrects (HU-E9-02); each event is corrected at most once. */
    correctsEventId: uuid('corrects_event_id').references((): AnyPgColumn => issuerEvents.id),
    /** Why the receiver corrects the event (MT Tabla K: free text, 5 to 500 characters). */
    correctionReason: text('correction_reason'),
    /** The receiver a nomination names (HU-E8-05), as requested; set on insert, immutable, only on a nomination. */
    nomination: jsonb('nomination'),
    /** `Idempotency-Key` of the request that created the event (HU-E8-02), unique per tenant; null for older rows. */
    idempotencyKey: varchar('idempotency_key', { length: 255 }),
    /** sha-256 hex of the canonical request, to detect a reused key. */
    requestHash: char('request_hash', { length: 64 }),
    status: varchar('status', { length: 16 }).notNull().default('pending'),
    signedXml: text('signed_xml'),
    signedAt: timestamp('signed_at', { withTimezone: true }),
    /** `dId` of the `siRecepEvento` call that carries it (up to 15 events share one). */
    batchDId: bigint('batch_d_id', { mode: 'bigint' }),
    sendAttemptedAt: timestamp('send_attempted_at', { withTimezone: true }),
    /** `dCodRes` and `dMsgRes` of this event's result; `dProtAut` when SIFEN gave one. */
    responseCode: varchar('response_code', { length: 8 }),
    responseMessage: text('response_message'),
    sifenProtocol: varchar('sifen_protocol', { length: 16 }),
    respondedAt: timestamp('responded_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('issuer_events_event_id_key').on(table.tenantId, table.environment, table.eventId),
    foreignKey({
      columns: [table.tenantId, table.documentId],
      foreignColumns: [documents.tenantId, documents.id],
      name: 'issuer_events_tenant_document_fk',
    }),
    uniqueIndex('issuer_events_open_idx')
      .on(table.tenantId, table.documentId, table.kind)
      .where(sql`${table.documentId} IS NOT NULL AND ${table.status} <> 'rejected'`),
    uniqueIndex('issuer_events_idempotency_idx')
      .on(table.tenantId, table.idempotencyKey)
      .where(sql`${table.idempotencyKey} IS NOT NULL`),
    check(
      'issuer_events_idempotency_pair',
      sql`(${table.idempotencyKey} IS NULL) = (${table.requestHash} IS NULL)`,
    ),
    index('issuer_events_to_send_idx')
      .on(table.tenantId, table.environment, table.createdAt)
      .where(sql`${table.status} = 'signed'`),
    // One open receiver event per CDC and kind; a partial and a total conformity count as different.
    uniqueIndex('issuer_events_receiver_open_idx')
      .on(
        table.tenantId,
        table.environment,
        table.targetCdc,
        table.kind,
        sql`coalesce(${table.receiverData}->>'conformityType', '')`,
      )
      .where(sql`${table.targetCdc} IS NOT NULL AND ${table.status} <> 'rejected'`),
    check(
      'issuer_events_kind_valid',
      sql`${table.kind} IN (${sql.raw(EVENT_KINDS.map((k) => `'${k}'`).join(', '))})`,
    ),
    check(
      'issuer_events_status_valid',
      sql`${table.status} IN (${sql.raw(ISSUER_EVENT_STATUSES.map((s) => `'${s}'`).join(', '))})`,
    ),
    check('issuer_events_event_id_range', sql`${table.eventId} BETWEEN 1 AND 9999999999`),
    check(
      'issuer_events_reason_length',
      sql`${table.reason} IS NULL OR char_length(${table.reason}) BETWEEN 5 AND 500`,
    ),
    check(
      'issuer_events_reason_required',
      sql`(${table.reason} IS NULL) = (${table.kind} IN ('conformity', 'receipt_notice'))`,
    ),
    check(
      'issuer_events_subject',
      sql`(${table.kind} = 'voiding') = (${table.voidRange} IS NOT NULL) AND (${table.kind} IN ('cancellation', 'nomination')) = (${table.documentId} IS NOT NULL) AND (${table.kind} IN ('conformity', 'disconformity', 'unawareness', 'receipt_notice')) = (${table.targetCdc} IS NOT NULL) AND (${table.targetCdc} IS NOT NULL) = (${table.receiverData} IS NOT NULL)`,
    ),
    uniqueIndex('issuer_events_correction_idx')
      .on(table.correctsEventId)
      .where(sql`${table.correctsEventId} IS NOT NULL AND ${table.status} <> 'rejected'`),
    check(
      'issuer_events_correction_pair',
      sql`(${table.correctsEventId} IS NULL) = (${table.correctionReason} IS NULL)`,
    ),
    check(
      'issuer_events_correction_reason_length',
      sql`${table.correctionReason} IS NULL OR char_length(${table.correctionReason}) BETWEEN 5 AND 500`,
    ),
    check(
      'issuer_events_correction_subject',
      sql`${table.correctsEventId} IS NULL OR (${table.targetCdc} IS NOT NULL AND ${table.kind} <> 'receipt_notice' AND ${table.correctsEventId} <> ${table.id})`,
    ),
    check(
      'issuer_events_target_cdc_format',
      sql`${table.targetCdc} IS NULL OR ${table.targetCdc} ~ '^[0-9]{44}$'`,
    ),
    check(
      'issuer_events_nomination_subject',
      sql`(${table.kind} = 'nomination') = (${table.nomination} IS NOT NULL)`,
    ),
    check(
      'issuer_events_signed_pair',
      sql`(${table.signedXml} IS NULL) = (${table.signedAt} IS NULL) AND (${table.status} = 'pending') = (${table.signedXml} IS NULL)`,
    ),
    check(
      'issuer_events_sent_pair',
      // A sent event has a batch id. The one exception is an event rejected locally before it was sent (a `LOC-` code).
      sql`((${table.status} IN ('pending', 'signed')) = (${table.batchDId} IS NULL) OR (${table.status} = 'rejected' AND ${table.batchDId} IS NULL AND ${table.responseCode} LIKE 'LOC-%')) AND (${table.batchDId} IS NULL) = (${table.sendAttemptedAt} IS NULL)`,
    ),
    check(
      'issuer_events_answered_pair',
      // The answer comes as a pair. approved and rejected carry it; pending, signed and sending never do;
      // unknown (an unanswered send) may carry it, as the reason it is unknown, or not.
      sql`(${table.responseCode} IS NULL) = (${table.respondedAt} IS NULL) AND (${table.status} = 'unknown' OR (${table.status} IN ('approved', 'rejected')) = (${table.responseCode} IS NOT NULL))`,
    ),
  ],
);

export const SUBSCRIPTION_STATUSES = ['trialing', 'active', 'past_due', 'cancelled'] as const;

/**
 * SaaS plans (HU-E15-01). Platform-level catalog, no `tenant_id`: `app_user` reads it,
 * only `platform_admin` writes it. Prices and included documents are NOT columns here:
 * they live in effective-dated `plan_prices` rows so a change is never retroactive.
 */
export const plans = pgTable(
  'plans',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    code: varchar('code', { length: 64 }).notNull().unique(),
    name: varchar('name', { length: 255 }).notNull(),
    currency: char('currency', { length: 3 }).notNull().default('PYG'),
    apiCallLimit: integer('api_call_limit'),
    /** `direct` = monthly plan for a tenant; `partner` = per-document pricing through `plan_price_tiers`. */
    audience: text('audience').notNull().default('direct'),
    features: jsonb('features')
      .notNull()
      .default(sql`'{}'::jsonb`),
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check('plans_code_format', sql`${table.code} ~ '^[a-z0-9]+(-[a-z0-9]+)*$'`),
    check('plans_audience_valid', sql`${table.audience} IN ('direct', 'partner')`),
    check(
      'plans_api_call_limit_nonneg',
      sql`${table.apiCallLimit} IS NULL OR ${table.apiCallLimit} >= 0`,
    ),
  ],
);

/**
 * Effective-dated plan terms (HU-E15-01). A price change inserts a new row; history is kept.
 * Validity is `[valid_from, valid_to]` (null `valid_to` = open); the migration adds an EXCLUDE
 * constraint (btree_gist) that forbids overlapping validity per plan. Written by ops only.
 */
export const planPrices = pgTable(
  'plan_prices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    planId: uuid('plan_id')
      .notNull()
      .references(() => plans.id),
    monthlyPrice: bigint('monthly_price', { mode: 'number' }).notNull(),
    includedDocuments: integer('included_documents').notNull(),
    overagePrice: bigint('overage_price', { mode: 'number' }).notNull(),
    validFrom: date('valid_from').notNull(),
    validTo: date('valid_to'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      'plan_prices_amounts_nonneg',
      sql`${table.monthlyPrice} >= 0 AND ${table.includedDocuments} >= 0 AND ${table.overagePrice} >= 0`,
    ),
    check(
      'plan_prices_valid_range',
      sql`${table.validTo} IS NULL OR ${table.validTo} >= ${table.validFrom}`,
    ),
  ],
);

/** Partner volume tiers (M1): unit price per document from `from_documents` upward. */
export const planPriceTiers = pgTable(
  'plan_price_tiers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    planPriceId: uuid('plan_price_id')
      .notNull()
      .references(() => planPrices.id),
    fromDocuments: integer('from_documents').notNull(),
    unitPrice: bigint('unit_price', { mode: 'number' }).notNull(),
  },
  (table) => [
    unique('plan_price_tiers_price_from_key').on(table.planPriceId, table.fromDocuments),
    check(
      'plan_price_tiers_amounts_nonneg',
      sql`${table.fromDocuments} >= 0 AND ${table.unitPrice} >= 0`,
    ),
  ],
);

/** A tenant's plan over time; at most one non-cancelled row per tenant. Written by ops only. */
export const subscriptions = pgTable(
  'subscriptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    planId: uuid('plan_id')
      .notNull()
      .references(() => plans.id),
    status: text('status').notNull().default('active'),
    /** Terms copied from `plan_prices` when assigned: a later price change never rewrites them. */
    monthlyPrice: bigint('monthly_price', { mode: 'number' }),
    overagePrice: bigint('overage_price', { mode: 'number' }),
    documentQuota: integer('document_quota'),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull().defaultNow(),
    endsAt: timestamp('ends_at', { withTimezone: true }),
    nextBillingAt: timestamp('next_billing_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('subscriptions_tenant_id_key').on(table.tenantId, table.id),
    uniqueIndex('subscriptions_one_live_per_tenant')
      .on(table.tenantId)
      .where(sql`${table.status} <> 'cancelled'`),
    check(
      'subscriptions_terms_nonneg',
      sql`coalesce(${table.monthlyPrice}, 0) >= 0 AND coalesce(${table.overagePrice}, 0) >= 0 AND coalesce(${table.documentQuota}, 0) >= 0`,
    ),
    check(
      'subscriptions_snapshot_complete',
      sql`(${table.monthlyPrice} IS NULL AND ${table.overagePrice} IS NULL AND ${table.documentQuota} IS NULL) OR (${table.monthlyPrice} IS NOT NULL AND ${table.overagePrice} IS NOT NULL AND ${table.documentQuota} IS NOT NULL)`,
    ),
    check(
      'subscriptions_status_valid',
      sql`${table.status} IN (${sqlList(SUBSCRIPTION_STATUSES)})`,
    ),
    check(
      'subscriptions_period_valid',
      sql`${table.endsAt} IS NULL OR ${table.endsAt} >= ${table.startsAt}`,
    ),
  ],
);

/** Manual payments recorded by ops (no gateway before v1.0). Append-only. */
export const payments = pgTable(
  'payments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    subscriptionId: uuid('subscription_id').notNull(),
    amount: bigint('amount', { mode: 'number' }).notNull(),
    currency: char('currency', { length: 3 }).notNull().default('PYG'),
    method: text('method').notNull().default('manual'),
    reference: text('reference'),
    paidAt: timestamp('paid_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      name: 'payments_subscription_fk',
      columns: [table.tenantId, table.subscriptionId],
      foreignColumns: [subscriptions.tenantId, subscriptions.id],
    }),
    check('payments_amount_positive', sql`${table.amount} > 0`),
    check('payments_method_valid', sql`${table.method} IN ('manual')`),
  ],
);

export const INVOICE_SAAS_STATUSES = ['draft', 'issued', 'paid', 'void'] as const;

/** Invoices of the SaaS itself to the tenant (not the tenant's own DE). One per subscription and month. */
export const invoicesSaas = pgTable(
  'invoices_saas',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    subscriptionId: uuid('subscription_id').notNull(),
    period: date('period', { mode: 'string' }).notNull(),
    amount: bigint('amount', { mode: 'number' }).notNull(),
    currency: char('currency', { length: 3 }).notNull().default('PYG'),
    status: text('status').notNull().default('draft'),
    issuedAt: timestamp('issued_at', { withTimezone: true }),
    pdfUrl: text('pdf_url'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      name: 'invoices_saas_subscription_fk',
      columns: [table.tenantId, table.subscriptionId],
      foreignColumns: [subscriptions.tenantId, subscriptions.id],
    }),
    unique('invoices_saas_subscription_period_key').on(table.subscriptionId, table.period),
    check('invoices_saas_amount_nonneg', sql`${table.amount} >= 0`),
    check(
      'invoices_saas_period_first_day',
      sql`${table.period} = date_trunc('month', ${table.period}::timestamp)::date`,
    ),
    check(
      'invoices_saas_status_valid',
      sql`${table.status} IN (${sqlList(INVOICE_SAAS_STATUSES)})`,
    ),
  ],
);

/**
 * Usage per tenant and month (HU-E15-02). Incremented with a single
 * `INSERT ... ON CONFLICT DO UPDATE`; a trigger forbids decrements.
 */
export const usageCounters = pgTable(
  'usage_counters',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    period: date('period', { mode: 'string' }).notNull(),
    documentsIssued: bigint('documents_issued', { mode: 'number' }).notNull().default(0),
    apiCalls: bigint('api_calls', { mode: 'number' }).notNull().default(0),
    notificationsSent: bigint('notifications_sent', { mode: 'number' }).notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ name: 'usage_counters_pkey', columns: [table.tenantId, table.period] }),
    check(
      'usage_counters_period_first_day',
      sql`${table.period} = date_trunc('month', ${table.period}::timestamp)::date`,
    ),
    check(
      'usage_counters_nonneg',
      sql`${table.documentsIssued} >= 0 AND ${table.apiCalls} >= 0 AND ${table.notificationsSent} >= 0`,
    ),
  ],
);

/**
 * Pauses of a tenant's sends after SIFEN blocked its RUC (HU-E6-05, Guía 2024: 10 to 60 minutes).
 * Append-only history: the active pause is the latest row whose `blocked_until` has not passed,
 * and the row count is the metric.
 */
export const rucBlocks = pgTable(
  'ruc_blocks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    environment: tenantEnvironment('environment').notNull(),
    blockedAt: timestamp('blocked_at', { withTimezone: true }).notNull().defaultNow(),
    blockedUntil: timestamp('blocked_until', { withTimezone: true }).notNull(),
    /** SIFEN's `dMsgRes` for the refused lote, capped; never XML or credentials. */
    reason: text('reason').notNull(),
  },
  (table) => [
    index('ruc_blocks_active_idx').on(table.tenantId, table.environment, table.blockedUntil),
    check('ruc_blocks_window', sql`${table.blockedUntil} > ${table.blockedAt}`),
    check('ruc_blocks_reason_length', sql`char_length(${table.reason}) <= 500`),
  ],
);

/**
 * Cache of `siConsRUC` answers (HU-E6-09). Global on purpose: the taxpayer registry is the same for every
 * tenant, so the table has no `tenant_id` (and no RLS); it is keyed by SIFEN environment and RUC. Only
 * definite answers are stored (found 0502, not found 0500); freshness is judged at read from `fetched_at`.
 */
export const rucLookupCache = pgTable(
  'ruc_lookup_cache',
  {
    environment: tenantEnvironment('environment').notNull(),
    /** RUC base, 5 to 8 digits, without the check digit. */
    ruc: text('ruc').notNull(),
    found: boolean('found').notNull(),
    razonSocial: text('razon_social'),
    /** `dCodEstCons`: ACT, SUS, SAD, BLQ, CAN or CDE. */
    estado: text('estado'),
    facturadorElectronico: boolean('facturador_electronico'),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.environment, table.ruc] }),
    check('ruc_lookup_cache_ruc_format', sql`${table.ruc} ~ '^[0-9]{5,8}$'`),
    check(
      'ruc_lookup_cache_found_shape',
      sql`(${table.found} AND ${table.razonSocial} IS NOT NULL AND ${table.estado} IS NOT NULL AND ${table.facturadorElectronico} IS NOT NULL) OR (NOT ${table.found} AND ${table.razonSocial} IS NULL AND ${table.estado} IS NULL AND ${table.facturadorElectronico} IS NULL)`,
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
  'audit_log',
  'document_emails',
  'documents',
  'issuer_events',
  'lote_documents',
  'invoices_saas',
  'lotes',
  'payments',
  'ruc_blocks',
  'subscriptions',
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
  'usage_counters',
  'webhook_deliveries',
  'webhook_endpoints',
] as const;
