-- Manual rollback for 0003_api_keys_rls.sql. Not registered in the drizzle
-- journal: run by hand against a migrated database if this PR is reverted.
DROP FUNCTION IF EXISTS touch_api_key_last_used(uuid);
DROP FUNCTION IF EXISTS resolve_api_key(text);

DROP POLICY IF EXISTS "platform_admin_all" ON "api_keys";
DROP POLICY IF EXISTS "tenant_isolation" ON "api_keys";

ALTER TABLE "api_keys" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "api_keys" DISABLE ROW LEVEL SECURITY;

REVOKE ALL ON "api_keys" FROM app_user;
REVOKE ALL ON "api_keys" FROM platform_admin;
