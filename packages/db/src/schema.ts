import { pgTable, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';

/**
 * Tenants master table. Not itself RLS-scoped (it has no `tenant_id`
 * column); it is the source of truth every tenant-scoped table references.
 */
export const tenants = pgTable('tenants', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: varchar('name', { length: 255 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Minimal tenant-scoped table used only by the isolation and RLS-drift test
 * suites (Phase 2) to prove the RLS policies without depending on any real
 * domain table.
 */
export const tenantProbe = pgTable('tenant_probe', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  label: varchar('label', { length: 255 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Every table that carries a `tenant_id` column and MUST be covered by
 * `FORCE ROW LEVEL SECURITY` plus a tenant-isolation policy. The Phase 2
 * `rls-coverage.spec.ts` drift check asserts this list matches
 * `pg_class.relforcerowsecurity` and `pg_policies` in the database.
 */
export const TENANT_TABLES = ['tenant_probe'] as const;
