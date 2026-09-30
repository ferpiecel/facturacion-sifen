-- Manual rollback for 0016 (guard trigger, RLS and grants only; 0015 owns the table).
DROP POLICY IF EXISTS "platform_admin_all" ON "tenant_request_sequences";
DROP POLICY IF EXISTS "tenant_isolation" ON "tenant_request_sequences";
ALTER TABLE "tenant_request_sequences" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "tenant_request_sequences" DISABLE ROW LEVEL SECURITY;
REVOKE ALL ON "tenant_request_sequences" FROM app_user;
REVOKE ALL ON "tenant_request_sequences" FROM platform_admin;
DROP TRIGGER IF EXISTS "tenant_request_sequences_guard" ON "tenant_request_sequences";
DROP FUNCTION IF EXISTS "tenant_request_sequences_guard"();
