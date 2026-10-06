CREATE TABLE "user_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"family_id" uuid NOT NULL,
	"access_hash" text NOT NULL,
	"refresh_hash" text NOT NULL,
	"access_expires_at" timestamp with time zone NOT NULL,
	"refresh_expires_at" timestamp with time zone NOT NULL,
	"absolute_expires_at" timestamp with time zone NOT NULL,
	"active_tenant_id" uuid,
	"mfa_verified_at" timestamp with time zone,
	"rotated_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_sessions_access_hash_key" UNIQUE("access_hash"),
	CONSTRAINT "user_sessions_refresh_hash_key" UNIQUE("refresh_hash"),
	CONSTRAINT "user_sessions_hashes_sha256" CHECK ("user_sessions"."access_hash" ~ '^[0-9a-f]{64}$' AND "user_sessions"."refresh_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "user_sessions_refresh_outlives_access" CHECK ("user_sessions"."refresh_expires_at" >= "user_sessions"."access_expires_at")
);
--> statement-breakpoint
ALTER TABLE "user_sessions" ADD CONSTRAINT "user_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_sessions" ADD CONSTRAINT "user_sessions_active_tenant_id_tenants_id_fk" FOREIGN KEY ("active_tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "user_sessions_user_id_idx" ON "user_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "user_sessions_family_id_idx" ON "user_sessions" USING btree ("family_id");
--> statement-breakpoint
-- session_resolver owns the SECURITY DEFINER functions below (same pattern as api_key_resolver, 0003):
-- NOLOGIN, not superuser, NOBYPASSRLS, no members, no memberships, and only the column privileges the
-- functions need. app_user can reach sessions solely through them; there is no table grant.
LOCK TABLE pg_catalog.pg_authid IN SHARE ROW EXCLUSIVE MODE;
--> statement-breakpoint
DO $$
DECLARE
  membership record;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'session_resolver') THEN
    CREATE ROLE session_resolver;
  END IF;
  ALTER ROLE session_resolver NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION NOLOGIN;
  FOR membership IN
    SELECT m.roleid::regrole::text AS granted, m.member::regrole::text AS member
    FROM pg_auth_members m
    WHERE m.member = 'session_resolver'::regrole OR m.roleid = 'session_resolver'::regrole
  LOOP
    EXECUTE format('REVOKE %s FROM %s', membership.granted, membership.member);
  END LOOP;
END
$$;
--> statement-breakpoint
ALTER TABLE "user_sessions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "user_sessions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "user_sessions" TO session_resolver;
--> statement-breakpoint
GRANT SELECT, UPDATE ON "user_sessions" TO platform_admin;
--> statement-breakpoint
CREATE POLICY "session_resolver_all" ON "user_sessions" TO session_resolver USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY "platform_admin_all" ON "user_sessions" TO platform_admin USING (true) WITH CHECK (true);
--> statement-breakpoint
GRANT SELECT (id, disabled_at) ON "users" TO session_resolver;
--> statement-breakpoint
CREATE POLICY "session_resolver_read" ON "users" FOR SELECT TO session_resolver USING (true);
--> statement-breakpoint
GRANT SELECT (tenant_id, user_id, role) ON "tenant_memberships" TO session_resolver;
--> statement-breakpoint
CREATE POLICY "session_resolver_read" ON "tenant_memberships" FOR SELECT TO session_resolver USING (true);
--> statement-breakpoint
GRANT SELECT (id, name) ON "tenants" TO session_resolver;
--> statement-breakpoint
CREATE POLICY "session_resolver_read" ON "tenants" FOR SELECT TO session_resolver USING (true);
--> statement-breakpoint
-- Every function: schema-qualified objects and a search_path with pg_temp last (see 0003).
-- A session for an active user; the expiries are clamped to the absolute cap chosen at login. mfa_verified_at stays null for the pending session between the
-- password and the second factor. Returns NULL for an unknown or disabled user.
CREATE FUNCTION public.create_user_session(
  p_user_id uuid, p_access_hash text, p_refresh_hash text,
  p_access_expires timestamptz, p_refresh_expires timestamptz, p_absolute_expires timestamptz,
  p_mfa_verified boolean)
RETURNS uuid
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
  INSERT INTO public.user_sessions
    (user_id, family_id, access_hash, refresh_hash, access_expires_at, refresh_expires_at,
     absolute_expires_at, mfa_verified_at)
  SELECT u.id, pg_catalog.gen_random_uuid(), p_access_hash, p_refresh_hash,
         LEAST(p_access_expires, p_absolute_expires),
         LEAST(p_refresh_expires, p_absolute_expires), p_absolute_expires, CASE WHEN p_mfa_verified THEN pg_catalog.now() END
  FROM public.users AS u WHERE u.id = p_user_id AND u.disabled_at IS NULL
  RETURNING id
$$;
--> statement-breakpoint
-- The live session of an access token: not rotated, not revoked, not expired, user not disabled.
CREATE FUNCTION public.resolve_user_session(p_access_hash text)
RETURNS TABLE (id uuid, user_id uuid, active_tenant_id uuid, mfa_verified_at timestamptz)
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
  SELECT s.id, s.user_id, s.active_tenant_id, s.mfa_verified_at
  FROM public.user_sessions AS s
  WHERE s.access_hash = p_access_hash AND s.rotated_at IS NULL AND s.revoked_at IS NULL
    AND s.access_expires_at > pg_catalog.now() AND s.absolute_expires_at > pg_catalog.now()
    AND EXISTS (SELECT 1 FROM public.users AS u WHERE u.id = s.user_id AND u.disabled_at IS NULL)
$$;
--> statement-breakpoint
-- Refresh rotation. The conditional UPDATE is the compare-and-set: of two concurrent refreshes with the
-- same token one wins, the other finds the row already rotated and is treated as a reuse, which revokes
-- the whole family (a stolen token is spent by whoever uses it second). A pending (non-MFA) session never
-- refreshes. The new generation keeps the family, tenant, MFA state and the ABSOLUTE cap (never past it: a refresh after
-- the cap is refused and the user logs in again), and gets a fresh sliding expiry clamped to that cap.
CREATE FUNCTION public.rotate_user_session(
  p_old_refresh_hash text, p_new_access_hash text, p_new_refresh_hash text,
  p_access_expires timestamptz, p_refresh_expires timestamptz)
RETURNS TABLE (id uuid, user_id uuid, active_tenant_id uuid, mfa_verified_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  old_row public.user_sessions;
BEGIN
  UPDATE public.user_sessions AS s SET rotated_at = pg_catalog.now()
  WHERE s.refresh_hash = p_old_refresh_hash AND s.rotated_at IS NULL AND s.revoked_at IS NULL
    AND s.mfa_verified_at IS NOT NULL AND s.refresh_expires_at > pg_catalog.now()
    AND s.absolute_expires_at > pg_catalog.now()
    AND EXISTS (SELECT 1 FROM public.users AS u WHERE u.id = s.user_id AND u.disabled_at IS NULL)
  RETURNING s.* INTO old_row;
  IF NOT FOUND THEN
    UPDATE public.user_sessions AS s SET revoked_at = pg_catalog.now()
    WHERE s.revoked_at IS NULL AND s.family_id IN (
      SELECT r.family_id FROM public.user_sessions AS r
      WHERE r.refresh_hash = p_old_refresh_hash AND r.rotated_at IS NOT NULL);
    RETURN;
  END IF;
  RETURN QUERY
    INSERT INTO public.user_sessions AS n
      (user_id, family_id, access_hash, refresh_hash, access_expires_at, refresh_expires_at,
       absolute_expires_at, active_tenant_id, mfa_verified_at)
    VALUES (old_row.user_id, old_row.family_id, p_new_access_hash, p_new_refresh_hash,
            LEAST(p_access_expires, old_row.absolute_expires_at),
            LEAST(p_refresh_expires, old_row.absolute_expires_at),
            old_row.absolute_expires_at, old_row.active_tenant_id, old_row.mfa_verified_at)
    RETURNING n.id, n.user_id, n.active_tenant_id, n.mfa_verified_at;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION public.revoke_user_session(p_session_id uuid)
RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
  UPDATE public.user_sessions SET revoked_at = pg_catalog.now() WHERE id = p_session_id AND revoked_at IS NULL
$$;
--> statement-breakpoint
-- Ends every live session of a user (MFA reset, password change, disabling); returns how many.
CREATE FUNCTION public.revoke_user_sessions(p_user_id uuid)
RETURNS integer
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
  WITH revoked AS (
    UPDATE public.user_sessions SET revoked_at = pg_catalog.now()
    WHERE user_id = p_user_id AND revoked_at IS NULL RETURNING 1)
  SELECT pg_catalog.count(*)::integer FROM revoked
$$;
--> statement-breakpoint
-- The tenants a user may choose from, with their names (the picker runs before any tenant is active).
CREATE FUNCTION public.list_user_memberships(p_user_id uuid)
RETURNS TABLE (tenant_id uuid, tenant_name text, role text)
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
  SELECT m.tenant_id, t.name::pg_catalog.text, m.role::pg_catalog.text
  FROM public.tenant_memberships AS m JOIN public.tenants AS t ON t.id = m.tenant_id
  WHERE m.user_id = p_user_id ORDER BY t.name
$$;
--> statement-breakpoint
-- Sets the active tenant of a live, MFA-verified session, only among the user's own tenants.
CREATE FUNCTION public.set_user_session_tenant(p_session_id uuid, p_tenant_id uuid)
RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
  WITH updated AS (
    UPDATE public.user_sessions AS s SET active_tenant_id = p_tenant_id
    WHERE s.id = p_session_id AND s.revoked_at IS NULL AND s.rotated_at IS NULL
      AND s.mfa_verified_at IS NOT NULL
      AND EXISTS (SELECT 1 FROM public.tenant_memberships AS m
                  WHERE m.user_id = s.user_id AND m.tenant_id = p_tenant_id)
    RETURNING 1)
  SELECT EXISTS (SELECT 1 FROM updated)
$$;

--> statement-breakpoint
ALTER FUNCTION public.create_user_session(uuid, text, text, timestamptz, timestamptz, timestamptz, boolean) OWNER TO session_resolver;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.create_user_session(uuid, text, text, timestamptz, timestamptz, timestamptz, boolean) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.create_user_session(uuid, text, text, timestamptz, timestamptz, timestamptz, boolean) TO app_user;
--> statement-breakpoint
ALTER FUNCTION public.resolve_user_session(text) OWNER TO session_resolver;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.resolve_user_session(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.resolve_user_session(text) TO app_user;
--> statement-breakpoint
ALTER FUNCTION public.rotate_user_session(text, text, text, timestamptz, timestamptz) OWNER TO session_resolver;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.rotate_user_session(text, text, text, timestamptz, timestamptz) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.rotate_user_session(text, text, text, timestamptz, timestamptz) TO app_user;
--> statement-breakpoint
ALTER FUNCTION public.revoke_user_session(uuid) OWNER TO session_resolver;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.revoke_user_session(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.revoke_user_session(uuid) TO app_user;
--> statement-breakpoint
ALTER FUNCTION public.revoke_user_sessions(uuid) OWNER TO session_resolver;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.revoke_user_sessions(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.revoke_user_sessions(uuid) TO app_user;
--> statement-breakpoint
ALTER FUNCTION public.list_user_memberships(uuid) OWNER TO session_resolver;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.list_user_memberships(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.list_user_memberships(uuid) TO app_user;
--> statement-breakpoint
ALTER FUNCTION public.set_user_session_tenant(uuid, uuid) OWNER TO session_resolver;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.set_user_session_tenant(uuid, uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.set_user_session_tenant(uuid, uuid) TO app_user;
