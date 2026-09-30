-- Manual rollback for 0012 (RLS/grants only; 0011 owns the table).
DROP POLICY IF EXISTS "platform_admin_all" ON "tenant_document_sequences";
DROP POLICY IF EXISTS "tenant_isolation" ON "tenant_document_sequences";
ALTER TABLE "tenant_document_sequences" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "tenant_document_sequences" DISABLE ROW LEVEL SECURITY;
REVOKE ALL ON "tenant_document_sequences" FROM app_user;
REVOKE ALL ON "tenant_document_sequences" FROM platform_admin;
