-- Manual rollback for 0074 (RLS and grants hand-written there).
DROP POLICY IF EXISTS "platform_admin_all" ON "received_artifacts";
DROP POLICY IF EXISTS "tenant_isolation" ON "received_artifacts";
ALTER TABLE "received_artifacts" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "received_artifacts" DISABLE ROW LEVEL SECURITY;
REVOKE ALL ON "received_artifacts" FROM app_user, platform_admin;
