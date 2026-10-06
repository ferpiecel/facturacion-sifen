-- Manual rollback for 0037 (RLS, grants and triggers hand-written there, then the tables and the enum).
DROP POLICY IF EXISTS "platform_admin_all" ON "tenant_memberships";
DROP POLICY IF EXISTS "tenant_isolation" ON "tenant_memberships";
DROP POLICY IF EXISTS "platform_admin_all" ON "users";
REVOKE ALL ON "tenant_memberships" FROM app_user, platform_admin;
REVOKE ALL ON "users" FROM platform_admin;
DROP TABLE IF EXISTS "tenant_memberships";
DROP TABLE IF EXISTS "users";
DROP FUNCTION IF EXISTS "tenant_memberships_guard"();
DROP FUNCTION IF EXISTS "users_guard"();
DROP TYPE IF EXISTS "public"."portal_role";
