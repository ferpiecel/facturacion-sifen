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
-- Pre-auth lookup by the public key_id, before any tenant context exists.
-- SECURITY DEFINER runs as the migration owner (never app_user), so it can
-- see rows across tenants; `SET search_path` pins name resolution against a
-- hostile search_path, and only the exact 5 columns the caller needs are
-- returned (never label/created_at/revoked_at). Revoked and unknown keys
-- both return zero rows, so callers cannot distinguish "revoked" from
-- "never existed".
CREATE FUNCTION resolve_api_key(p_key_id text)
RETURNS TABLE (
  id uuid,
  tenant_id uuid,
  secret_hash text,
  scopes text[],
  environment text
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT api_keys.id, api_keys.tenant_id, api_keys.secret_hash, api_keys.scopes,
         api_keys.environment::text
  FROM api_keys
  WHERE api_keys.key_id = p_key_id AND api_keys.revoked_at IS NULL
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION resolve_api_key(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION resolve_api_key(text) TO app_user;
--> statement-breakpoint
-- Records successful authentication. Updates last_used_at only: no other
-- column, including revoked_at, is reachable through this path.
CREATE FUNCTION touch_api_key_last_used(p_id uuid)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  UPDATE api_keys SET last_used_at = now() WHERE api_keys.id = p_id
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION touch_api_key_last_used(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION touch_api_key_last_used(uuid) TO app_user;
