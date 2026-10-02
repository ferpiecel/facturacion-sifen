-- Manual rollback for 0021 (RLS, grants and trigger hand-written there, then the table).
DROP POLICY IF EXISTS "platform_admin_all" ON "documents";
DROP POLICY IF EXISTS "tenant_isolation" ON "documents";
ALTER TABLE "documents" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "documents" DISABLE ROW LEVEL SECURITY;
REVOKE ALL ON "documents" FROM app_user;
REVOKE ALL ON "documents" FROM platform_admin;
DROP TRIGGER IF EXISTS "documents_guard" ON "documents";
DROP FUNCTION IF EXISTS "documents_guard"();
DROP TABLE IF EXISTS "documents";
