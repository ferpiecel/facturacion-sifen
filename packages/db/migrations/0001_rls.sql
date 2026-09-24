-- Idempotent, concurrency-safe role creation: roles are cluster-wide (not
-- per-database), and the test harness creates one fresh database per spec
-- file and migrates them concurrently, so an `IF NOT EXISTS` check-then-act
-- race is not safe here. Each nested block catches the role already having
-- been created by a concurrent migration between the check and the
-- `CREATE ROLE` (surfaces as `unique_violation` on `pg_authid`, not
-- `duplicate_object`, because the two `CREATE ROLE` statements interleave).
DO $$
BEGIN
  BEGIN
    CREATE ROLE app_user NOLOGIN NOBYPASSRLS;
  EXCEPTION
    WHEN duplicate_object OR unique_violation THEN
      NULL;
  END;

  BEGIN
    CREATE ROLE platform_admin NOLOGIN NOBYPASSRLS;
  EXCEPTION
    WHEN duplicate_object OR unique_violation THEN
      NULL;
  END;
END
$$;
--> statement-breakpoint
-- Only tenant-scoped tables (TENANT_TABLES in schema.ts) get RLS. `tenants`
-- itself has no `tenant_id` column and stays unscoped.
ALTER TABLE "tenant_probe" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "tenant_probe" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- app_user is the only role request/job code connects as (via `SET LOCAL
-- ROLE` in withTenantTransaction). It needs table privileges in addition to
-- the RLS policy below: RLS filters rows, it does not grant access.
GRANT SELECT ON "tenants" TO app_user;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "tenant_probe" TO app_user;
--> statement-breakpoint
-- platform_admin is never used by request/job handling code; it exists only
-- for deliberate, audited cross-tenant access (ADR-0005).
GRANT SELECT ON "tenants" TO platform_admin;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "tenant_probe" TO platform_admin;
--> statement-breakpoint
-- `nullif(..., '')` makes the policy deny by default: `current_setting`
-- returns '' (not NULL) when unset because `withTenantTransaction` always
-- calls it with `missing_ok = true`, and `''::uuid` would otherwise raise
-- instead of comparing false.
CREATE POLICY "tenant_isolation" ON "tenant_probe"
  TO app_user
  USING (tenant_id = nullif(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.current_tenant', true), '')::uuid);
--> statement-breakpoint
-- Deliberate, explicit cross-tenant path. Not reachable from apps/api or
-- worker job handling: only withTenantTransaction sets the role, and it
-- always sets it to app_user.
CREATE POLICY "platform_admin_all" ON "tenant_probe"
  TO platform_admin
  USING (true)
  WITH CHECK (true);
