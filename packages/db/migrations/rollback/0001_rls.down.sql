-- Manual rollback for 0001_rls.sql. Not registered in the drizzle journal:
-- run by hand against a migrated database if PR 2 is reverted.
DROP POLICY IF EXISTS "platform_admin_all" ON "tenant_probe";
DROP POLICY IF EXISTS "tenant_isolation" ON "tenant_probe";

ALTER TABLE "tenant_probe" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "tenant_probe" DISABLE ROW LEVEL SECURITY;

REVOKE ALL ON "tenant_probe" FROM app_user;
REVOKE ALL ON "tenants" FROM app_user;
REVOKE ALL ON "tenant_probe" FROM platform_admin;
REVOKE ALL ON "tenants" FROM platform_admin;

DROP ROLE IF EXISTS app_user;
DROP ROLE IF EXISTS platform_admin;
