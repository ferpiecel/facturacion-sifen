-- Roles are cluster-wide and may pre-exist, so every attribute and
-- membership is re-asserted, never trusted; the shared pg_authid lock
-- serializes concurrent migrations. app_login is the runtime's only login:
-- not owner, not superuser, NOBYPASSRLS, NOINHERIT, member of app_user only,
-- so RESET ROLE / SET ROLE cannot escape RLS (ADR-0016).
LOCK TABLE pg_catalog.pg_authid IN SHARE ROW EXCLUSIVE MODE;
--> statement-breakpoint
DO $$
DECLARE
  role_name text;
  membership record;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['app_user', 'platform_admin', 'app_login'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('CREATE ROLE %I', role_name);
    END IF;
    EXECUTE format('ALTER ROLE %I NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE '
      'NOREPLICATION NOLOGIN', role_name);
  END LOOP;

  FOR membership IN
    SELECT m.roleid::regrole::text AS granted, m.member::regrole::text AS member
    FROM pg_auth_members m
    WHERE m.member IN ('app_user'::regrole, 'platform_admin'::regrole, 'app_login'::regrole)
  LOOP
    EXECUTE format('REVOKE %s FROM %s', membership.granted, membership.member);
  END LOOP;
END
$$;
--> statement-breakpoint
ALTER ROLE app_login LOGIN NOINHERIT;
--> statement-breakpoint
GRANT app_user TO app_login;
--> statement-breakpoint
-- `tenants` has no `tenant_id` column but is still tenant data: app_user
-- sees only its own row (policies below).
ALTER TABLE "tenants" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "tenants" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "tenant_probe" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "tenant_probe" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- app_user is the only role request/job code connects as (via `SET LOCAL
-- ROLE` in withTenantTransaction). It needs table privileges in addition to
-- the RLS policy below: RLS filters rows, it does not grant access.
GRANT SELECT ON "tenants" TO app_user;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "tenant_probe" TO app_user;
--> statement-breakpoint
-- platform_admin is never used by request/job handling code; it exists only
-- for deliberate, audited cross-tenant access (ADR-0005).
GRANT SELECT ON "tenants" TO platform_admin;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "tenant_probe" TO platform_admin;
--> statement-breakpoint
-- `nullif(..., '')` makes the policy deny by default: `current_setting`
-- returns '' (not NULL) when unset because `withTenantTransaction` always
-- calls it with `missing_ok = true`, and `''::uuid` would otherwise raise
-- instead of comparing false.
CREATE POLICY "tenant_isolation" ON "tenant_probe"
  TO app_user
  USING (tenant_id = nullif(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.current_tenant', true), '')::uuid);
--> statement-breakpoint
-- Deliberate, explicit cross-tenant path. Not reachable from apps/api or
-- worker job handling: only withTenantTransaction sets the role, and it
-- always sets it to app_user.
CREATE POLICY "platform_admin_all" ON "tenant_probe"
  TO platform_admin
  USING (true)
  WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY "tenant_self" ON "tenants"
  FOR SELECT
  TO app_user
  USING (id = nullif(current_setting('app.current_tenant', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "platform_admin_all" ON "tenants"
  TO platform_admin
  USING (true)
  WITH CHECK (true);
