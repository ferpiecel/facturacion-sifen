-- Manual rollback for 0001_rls.sql. Not registered in the drizzle journal:
-- run by hand against a migrated database if PR 2 is reverted.
DROP POLICY IF EXISTS "platform_admin_all" ON "tenant_probe";
DROP POLICY IF EXISTS "tenant_isolation" ON "tenant_probe";
DROP POLICY IF EXISTS "platform_admin_all" ON "tenants";
DROP POLICY IF EXISTS "tenant_self" ON "tenants";

ALTER TABLE "tenant_probe" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "tenant_probe" DISABLE ROW LEVEL SECURITY;
ALTER TABLE "tenants" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "tenants" DISABLE ROW LEVEL SECURITY;

REVOKE ALL ON "tenant_probe" FROM app_user;
REVOKE ALL ON "tenants" FROM app_user;
REVOKE ALL ON "tenant_probe" FROM platform_admin;
REVOKE ALL ON "tenants" FROM platform_admin;

-- Roles are cluster-wide and may still be used by other databases, so they
-- are intentionally NOT dropped here. Once no database references them, drop
-- them by hand: `DROP OWNED BY app_login, app_user, platform_admin;` in each
-- database, then `DROP ROLE app_login, app_user, platform_admin;`.
