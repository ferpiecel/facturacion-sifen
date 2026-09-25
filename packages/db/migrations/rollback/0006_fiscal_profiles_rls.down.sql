-- Manual rollback for 0006_fiscal_profiles_rls.sql. Not registered in the
-- drizzle journal: run by hand against a migrated database if this PR is
-- reverted. Does not drop the tables (0005_orange_stepford_cuckoos.sql owns
-- those); only undoes RLS, grants and policies.
DROP POLICY IF EXISTS "platform_admin_all" ON "tenant_fiscal_economic_activities";
DROP POLICY IF EXISTS "tenant_isolation" ON "tenant_fiscal_economic_activities";

DROP POLICY IF EXISTS "platform_admin_all" ON "tenant_fiscal_profiles";
DROP POLICY IF EXISTS "tenant_isolation" ON "tenant_fiscal_profiles";

ALTER TABLE "tenant_fiscal_economic_activities" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "tenant_fiscal_economic_activities" DISABLE ROW LEVEL SECURITY;

ALTER TABLE "tenant_fiscal_profiles" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "tenant_fiscal_profiles" DISABLE ROW LEVEL SECURITY;

REVOKE ALL ON "tenant_fiscal_economic_activities" FROM app_user;
REVOKE ALL ON "tenant_fiscal_economic_activities" FROM platform_admin;

REVOKE ALL ON "tenant_fiscal_profiles" FROM app_user;
REVOKE ALL ON "tenant_fiscal_profiles" FROM platform_admin;
