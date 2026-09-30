-- RLS, grants and append-only enforcement for audit_log (HU-E13-01).
-- app_user and platform_admin may only SELECT and INSERT; a trigger rejects
-- UPDATE, DELETE and TRUNCATE for every role except the NOLOGIN
-- `audit_maintenance` role, reserved for documented retention/maintenance
-- work (membership is granted manually by a DBA, never by the app). A
-- pre-existing role has every membership (of it and to it) revoked here.
-- occurred_at is forced to now() on INSERT for every other role, so entries
-- cannot be backdated. Operational control: the table owner (the migration
-- role) can still disable triggers; keep that role out of the app's reach.
LOCK TABLE pg_catalog.pg_authid IN SHARE ROW EXCLUSIVE MODE;
--> statement-breakpoint
DO $$
DECLARE
  membership record;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'audit_maintenance') THEN
    CREATE ROLE audit_maintenance;
  END IF;
  ALTER ROLE audit_maintenance NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE
    NOREPLICATION NOLOGIN;
  FOR membership IN
    SELECT m.roleid::regrole::text AS granted, m.member::regrole::text AS member
    FROM pg_auth_members m
    WHERE m.member = 'audit_maintenance'::regrole OR m.roleid = 'audit_maintenance'::regrole
  LOOP
    EXECUTE format('REVOKE %s FROM %s', membership.granted, membership.member);
  END LOOP;
END
$$;
--> statement-breakpoint
ALTER TABLE "audit_log" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "audit_log" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT ON "audit_log" TO app_user;
--> statement-breakpoint
GRANT SELECT, INSERT ON "audit_log" TO platform_admin;
--> statement-breakpoint
GRANT SELECT, DELETE ON "audit_log" TO audit_maintenance;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "audit_log"
  TO app_user
  USING (tenant_id = nullif(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.current_tenant', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "platform_admin_all" ON "audit_log"
  TO platform_admin
  USING (true)
  WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY "maintenance_all" ON "audit_log"
  TO audit_maintenance
  USING (true)
  WITH CHECK (true);
--> statement-breakpoint
CREATE FUNCTION audit_log_reject_mutation() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF current_user = 'audit_maintenance' THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'audit_log is append-only: % is not allowed', TG_OP
    USING ERRCODE = 'restrict_violation';
END
$$;
--> statement-breakpoint
CREATE TRIGGER audit_log_append_only
  BEFORE UPDATE OR DELETE ON "audit_log"
  FOR EACH ROW EXECUTE FUNCTION audit_log_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER audit_log_no_truncate
  BEFORE TRUNCATE ON "audit_log"
  FOR EACH STATEMENT EXECUTE FUNCTION audit_log_reject_mutation();
--> statement-breakpoint
CREATE FUNCTION audit_log_force_occurred_at() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF current_user <> 'audit_maintenance' THEN
    NEW.occurred_at := now();
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER audit_log_force_occurred_at
  BEFORE INSERT ON "audit_log"
  FOR EACH ROW EXECUTE FUNCTION audit_log_force_occurred_at();
