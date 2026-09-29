-- Manual rollback for 0008_establishment_tables_rls.sql. Not registered in
-- the drizzle journal: run by hand against a migrated database if this PR
-- is reverted. Does not drop the tables (0007_abandoned_titanium_man.sql
-- owns those); only undoes RLS, grants and policies.
DROP POLICY IF EXISTS "platform_admin_all" ON "tenant_timbrados";
DROP POLICY IF EXISTS "tenant_isolation" ON "tenant_timbrados";

DROP POLICY IF EXISTS "platform_admin_all" ON "tenant_expedition_points";
DROP POLICY IF EXISTS "tenant_isolation" ON "tenant_expedition_points";

DROP POLICY IF EXISTS "platform_admin_all" ON "tenant_establishments";
DROP POLICY IF EXISTS "tenant_isolation" ON "tenant_establishments";

ALTER TABLE "tenant_timbrados" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "tenant_timbrados" DISABLE ROW LEVEL SECURITY;

ALTER TABLE "tenant_expedition_points" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "tenant_expedition_points" DISABLE ROW LEVEL SECURITY;

ALTER TABLE "tenant_establishments" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "tenant_establishments" DISABLE ROW LEVEL SECURITY;

REVOKE ALL ON "tenant_timbrados" FROM app_user;
REVOKE ALL ON "tenant_timbrados" FROM platform_admin;

REVOKE ALL ON "tenant_expedition_points" FROM app_user;
REVOKE ALL ON "tenant_expedition_points" FROM platform_admin;

REVOKE ALL ON "tenant_establishments" FROM app_user;
REVOKE ALL ON "tenant_establishments" FROM platform_admin;
