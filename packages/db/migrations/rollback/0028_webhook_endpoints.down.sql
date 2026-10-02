-- Manual rollback for 0028 (RLS, grants and trigger hand-written there, then the table).
DROP POLICY IF EXISTS "platform_admin_all" ON "webhook_endpoints";
DROP POLICY IF EXISTS "tenant_isolation" ON "webhook_endpoints";
REVOKE ALL ON "webhook_endpoints" FROM app_user, platform_admin;
DROP TABLE IF EXISTS "webhook_endpoints";
DROP FUNCTION IF EXISTS "webhook_endpoints_guard"();
