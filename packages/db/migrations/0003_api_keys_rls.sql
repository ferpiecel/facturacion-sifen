-- RLS + grants for api_keys (same pattern as 0001_rls.sql), plus the two
-- SECURITY DEFINER functions that let the API resolve an api key before a
-- tenant context exists (ADR-0005 / ADR-0016): direct SELECT on api_keys
-- always requires app.current_tenant, so there is no other bypass.
ALTER TABLE "api_keys" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "api_keys" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "api_keys" TO app_user;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "api_keys" TO platform_admin;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "api_keys"
  TO app_user
  USING (tenant_id = nullif(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.current_tenant', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "platform_admin_all" ON "api_keys"
  TO platform_admin
  USING (true)
  WITH CHECK (true);
--> statement-breakpoint
-- api_key_resolver owns the two pre-auth functions below, so SECURITY
-- DEFINER runs as it, never as the migration superuser. It is NOLOGIN, not
-- superuser, NOBYPASSRLS, not the table owner (so RLS applies to it), has no
-- members and no memberships, and only the column privileges it needs.
LOCK TABLE pg_catalog.pg_authid IN SHARE ROW EXCLUSIVE MODE;
--> statement-breakpoint
DO $$
DECLARE
  membership record;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'api_key_resolver') THEN
    CREATE ROLE api_key_resolver;
  END IF;
  ALTER ROLE api_key_resolver NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE
    NOREPLICATION NOLOGIN;
  FOR membership IN
    SELECT m.roleid::regrole::text AS granted, m.member::regrole::text AS member
    FROM pg_auth_members m
    WHERE m.member = 'api_key_resolver'::regrole OR m.roleid = 'api_key_resolver'::regrole
  LOOP
    EXECUTE format('REVOKE %s FROM %s', membership.granted, membership.member);
  END LOOP;
END
$$;
--> statement-breakpoint
GRANT SELECT (id, tenant_id, key_id, secret_hash, scopes, environment, revoked_at)
  ON "api_keys" TO api_key_resolver;
--> statement-breakpoint
GRANT UPDATE (last_used_at) ON "api_keys" TO api_key_resolver;
--> statement-breakpoint
CREATE POLICY "api_key_resolver_read" ON "api_keys"
  FOR SELECT
  TO api_key_resolver
  USING (true);
--> statement-breakpoint
CREATE POLICY "api_key_resolver_touch" ON "api_keys"
  FOR UPDATE
  TO api_key_resolver
  USING (revoked_at IS NULL)
  WITH CHECK (revoked_at IS NULL);
--> statement-breakpoint
-- Pre-auth lookup by the public key_id, before any tenant context exists.
-- Every object is schema-qualified and search_path puts pg_temp LAST: a
-- search_path without pg_temp searches it FIRST, so a caller's
-- `CREATE TEMP TABLE api_keys` would otherwise shadow the real table.
-- Only the 5 columns the caller needs are returned. Revoked and unknown
-- keys both return zero rows, so callers cannot tell them apart.
CREATE FUNCTION public.resolve_api_key(p_key_id text)
RETURNS TABLE (
  id uuid,
  tenant_id uuid,
  secret_hash text,
  scopes text[],
  environment text
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT k.id, k.tenant_id, k.secret_hash, k.scopes, k.environment::pg_catalog.text
  FROM public.api_keys AS k
  WHERE k.key_id OPERATOR(pg_catalog.=) p_key_id AND k.revoked_at IS NULL
$$;
--> statement-breakpoint
ALTER FUNCTION public.resolve_api_key(text) OWNER TO api_key_resolver;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.resolve_api_key(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.resolve_api_key(text) TO app_user;
--> statement-breakpoint
-- Records successful authentication of an active key. Updates last_used_at
-- only: no other column, including revoked_at, is reachable through this path.
CREATE FUNCTION public.touch_api_key_last_used(p_id uuid)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  UPDATE public.api_keys SET last_used_at = pg_catalog.now()
  WHERE id OPERATOR(pg_catalog.=) p_id AND revoked_at IS NULL
$$;
--> statement-breakpoint
ALTER FUNCTION public.touch_api_key_last_used(uuid) OWNER TO api_key_resolver;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.touch_api_key_last_used(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.touch_api_key_last_used(uuid) TO app_user;
