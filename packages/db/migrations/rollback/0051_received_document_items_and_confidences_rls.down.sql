-- Manual rollback for 0051 (RLS and grants hand-written there).
DROP POLICY IF EXISTS "platform_admin_all" ON "received_document_items";
DROP POLICY IF EXISTS "tenant_isolation" ON "received_document_items";
ALTER TABLE "received_document_items" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "received_document_items" DISABLE ROW LEVEL SECURITY;
REVOKE ALL ON "received_document_items" FROM app_user, platform_admin;
DROP POLICY IF EXISTS "platform_admin_all" ON "received_document_field_confidences";
DROP POLICY IF EXISTS "tenant_isolation" ON "received_document_field_confidences";
ALTER TABLE "received_document_field_confidences" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "received_document_field_confidences" DISABLE ROW LEVEL SECURITY;
REVOKE ALL ON "received_document_field_confidences" FROM app_user, platform_admin;
