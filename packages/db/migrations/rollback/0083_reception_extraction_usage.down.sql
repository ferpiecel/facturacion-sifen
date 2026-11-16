-- Manual rollback for 0083 (table, RLS and grants).
DROP POLICY IF EXISTS "platform_admin_all" ON "reception_extraction_usage";
DROP POLICY IF EXISTS "tenant_isolation" ON "reception_extraction_usage";
REVOKE ALL ON "reception_extraction_usage" FROM app_user, platform_admin;
DROP TABLE "reception_extraction_usage";
