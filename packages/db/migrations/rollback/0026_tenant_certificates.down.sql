-- Manual rollback for 0026 (RLS, grants and trigger hand-written there, then the table).
DROP POLICY IF EXISTS "platform_admin_all" ON "tenant_certificates";
DROP POLICY IF EXISTS "tenant_isolation" ON "tenant_certificates";
ALTER TABLE "tenant_certificates" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "tenant_certificates" DISABLE ROW LEVEL SECURITY;
REVOKE ALL ON "tenant_certificates" FROM app_user;
REVOKE ALL ON "tenant_certificates" FROM platform_admin;
DROP TRIGGER IF EXISTS "tenant_certificates_guard" ON "tenant_certificates";
DROP FUNCTION IF EXISTS "tenant_certificates_guard"();
DROP TABLE IF EXISTS "tenant_certificates";
