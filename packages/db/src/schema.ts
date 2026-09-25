import { sql } from 'drizzle-orm';
import {
  check,
  index,
  pgEnum,
  pgTable,
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

/**
 * Every table that carries a `tenant_id` column and MUST be covered by
 * `FORCE ROW LEVEL SECURITY` plus a tenant-isolation policy. The
 * `rls-coverage.spec.ts` drift check discovers these tables from the
 * catalog and asserts this list matches it.
 */
export const TENANT_TABLES = ['api_keys', 'tenant_probe'] as const;
