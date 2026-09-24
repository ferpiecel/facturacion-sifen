import { index, pgTable, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';

/**
 * Tenants master table: the source of truth every tenant-scoped table
 * references. It has no `tenant_id` column, but RLS still limits `app_user`
 * to its own row (`id = app.current_tenant`).
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

/**
 * Every table that carries a `tenant_id` column and MUST be covered by
 * `FORCE ROW LEVEL SECURITY` plus a tenant-isolation policy. The
 * `rls-coverage.spec.ts` drift check discovers these tables from the
 * catalog and asserts this list matches it.
 */
export const TENANT_TABLES = ['tenant_probe'] as const;
