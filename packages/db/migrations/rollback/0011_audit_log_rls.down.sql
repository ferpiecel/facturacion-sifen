-- Manual rollback for 0011_audit_log_rls.sql. Not registered in the drizzle
-- journal: run by hand if this PR is reverted. Does not drop the table
-- (0010_audit_log.sql owns it) nor the cluster-wide audit_maintenance role.
DROP TRIGGER IF EXISTS "audit_log_no_truncate" ON "audit_log";
DROP TRIGGER IF EXISTS "audit_log_append_only" ON "audit_log";
DROP FUNCTION IF EXISTS audit_log_reject_mutation();
DROP POLICY IF EXISTS "maintenance_all" ON "audit_log";
DROP POLICY IF EXISTS "platform_admin_all" ON "audit_log";
DROP POLICY IF EXISTS "tenant_isolation" ON "audit_log";
REVOKE ALL ON "audit_log" FROM audit_maintenance, platform_admin, app_user;
ALTER TABLE "audit_log" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "audit_log" DISABLE ROW LEVEL SECURITY;
