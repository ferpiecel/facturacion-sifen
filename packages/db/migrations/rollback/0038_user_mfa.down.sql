-- Manual rollback for 0038 (RLS, grants, trigger and check function hand-written there, then the table).
DROP POLICY IF EXISTS "platform_admin_all" ON "user_mfa";
REVOKE ALL ON "user_mfa" FROM platform_admin;
DROP TABLE IF EXISTS "user_mfa";
DROP FUNCTION IF EXISTS "user_mfa_guard"();
DROP FUNCTION IF EXISTS "user_mfa_hashes_valid"(text[]);
