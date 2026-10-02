-- Manual rollback for 0029 (RLS, grants and trigger hand-written there, then the table).
DROP POLICY IF EXISTS "platform_admin_all" ON "webhook_deliveries";
DROP POLICY IF EXISTS "tenant_isolation" ON "webhook_deliveries";
REVOKE ALL ON "webhook_deliveries" FROM app_user, platform_admin;
DROP TABLE IF EXISTS "webhook_deliveries";
DROP FUNCTION IF EXISTS "webhook_deliveries_guard"();
