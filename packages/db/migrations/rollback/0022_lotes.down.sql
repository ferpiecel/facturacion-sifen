-- Manual rollback for 0022 (RLS, grants and trigger hand-written there, then the tables).
DROP POLICY IF EXISTS "platform_admin_all" ON "lote_documents";
DROP POLICY IF EXISTS "tenant_isolation" ON "lote_documents";
ALTER TABLE "lote_documents" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "lote_documents" DISABLE ROW LEVEL SECURITY;
REVOKE ALL ON "lote_documents" FROM app_user;
REVOKE ALL ON "lote_documents" FROM platform_admin;
DROP TABLE IF EXISTS "lote_documents";
DROP POLICY IF EXISTS "platform_admin_all" ON "lotes";
DROP POLICY IF EXISTS "tenant_isolation" ON "lotes";
ALTER TABLE "lotes" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "lotes" DISABLE ROW LEVEL SECURITY;
REVOKE ALL ON "lotes" FROM app_user;
REVOKE ALL ON "lotes" FROM platform_admin;
DROP TRIGGER IF EXISTS "lotes_guard" ON "lotes";
DROP FUNCTION IF EXISTS "lotes_guard"();
DROP TABLE IF EXISTS "lotes";
ALTER TABLE "documents" DROP CONSTRAINT IF EXISTS "documents_tenant_id_key";
