-- Manual rollback for 0076 (RLS and grants hand-written there).
DROP POLICY IF EXISTS "platform_admin_all" ON "received_documents";
DROP POLICY IF EXISTS "tenant_isolation" ON "received_documents";
ALTER TABLE "received_documents" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "received_documents" DISABLE ROW LEVEL SECURITY;
REVOKE ALL ON "received_documents" FROM app_user, platform_admin;
