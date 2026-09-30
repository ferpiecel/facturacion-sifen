DROP POLICY IF EXISTS "platform_admin_all" ON "tenant_cscs";
DROP POLICY IF EXISTS "tenant_isolation" ON "tenant_cscs";
ALTER TABLE "tenant_cscs" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "tenant_cscs" DISABLE ROW LEVEL SECURITY;
REVOKE ALL ON "tenant_cscs" FROM app_user;
REVOKE ALL ON "tenant_cscs" FROM platform_admin;
DROP TRIGGER IF EXISTS "tenant_cscs_enforce_limit" ON "tenant_cscs";
DROP FUNCTION IF EXISTS "tenant_cscs_enforce_limit"();
