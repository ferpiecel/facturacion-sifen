-- Manual rollback for 0011_document_sequences_rls.sql. Not registered in the
-- drizzle journal. Does not drop the table (0010 owns it); only undoes RLS,
-- grants and policies.
DROP POLICY IF EXISTS "platform_admin_all" ON "tenant_document_sequences";
DROP POLICY IF EXISTS "tenant_isolation" ON "tenant_document_sequences";
ALTER TABLE "tenant_document_sequences" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "tenant_document_sequences" DISABLE ROW LEVEL SECURITY;
REVOKE ALL ON "tenant_document_sequences" FROM app_user;
REVOKE ALL ON "tenant_document_sequences" FROM platform_admin;
