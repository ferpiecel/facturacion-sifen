ALTER TABLE "user_mfa" ADD COLUMN "consecutive_failures" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "user_mfa" ADD COLUMN "mfa_locked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "sessions_valid_after" timestamp with time zone DEFAULT 'epoch' NOT NULL;
--> statement-breakpoint
-- Revoke-all vs a concurrent promote/create/rotate (re-review finding): a new session row used to be
-- invisible to a revoke-all that was waiting on the pending row's lock, so it survived. users.sessions_valid_after
-- closes it without row locks or extra privileges: revoke_user_sessions stamps it, and every session is live only
-- if it was created at or after the stamp (created_at is the creating transaction's start, so a session whose
-- transaction began before the revoke is dead even if it committed after it).
GRANT SELECT (sessions_valid_after), UPDATE (sessions_valid_after) ON "users" TO session_resolver;
--> statement-breakpoint
CREATE POLICY "session_resolver_stamp" ON "users" FOR UPDATE TO session_resolver USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.resolve_user_session(p_access_hash text)
RETURNS TABLE (id uuid, user_id uuid, active_tenant_id uuid, mfa_verified_at timestamptz,
  access_expires_at timestamptz, refresh_expires_at timestamptz)
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
  SELECT s.id, s.user_id, s.active_tenant_id, s.mfa_verified_at, s.access_expires_at, s.refresh_expires_at
  FROM public.user_sessions AS s
  WHERE s.access_hash = p_access_hash AND s.rotated_at IS NULL AND s.revoked_at IS NULL
    AND s.access_expires_at > pg_catalog.now() AND s.absolute_expires_at > pg_catalog.now()
    AND EXISTS (SELECT 1 FROM public.users AS u WHERE u.id = s.user_id AND u.disabled_at IS NULL
                AND s.created_at >= u.sessions_valid_after)
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.rotate_user_session(
  p_old_refresh_hash text, p_new_access_hash text, p_new_refresh_hash text,
  p_access_expires timestamptz, p_refresh_expires timestamptz)
RETURNS TABLE (id uuid, user_id uuid, active_tenant_id uuid, mfa_verified_at timestamptz,
  access_expires_at timestamptz, refresh_expires_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  old_row public.user_sessions;
BEGIN
  UPDATE public.user_sessions AS s SET rotated_at = pg_catalog.now()
  WHERE s.refresh_hash = p_old_refresh_hash AND s.rotated_at IS NULL AND s.revoked_at IS NULL
    AND s.mfa_verified_at IS NOT NULL AND s.refresh_expires_at > pg_catalog.now()
    AND s.absolute_expires_at > pg_catalog.now()
    AND EXISTS (SELECT 1 FROM public.users AS u WHERE u.id = s.user_id AND u.disabled_at IS NULL
                AND s.created_at >= u.sessions_valid_after)
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
    RETURNING n.id, n.user_id, n.active_tenant_id, n.mfa_verified_at, n.access_expires_at,
              n.refresh_expires_at;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.promote_user_session(
  p_pending_id uuid, p_access_hash text, p_refresh_hash text,
  p_access_expires timestamptz, p_refresh_expires timestamptz, p_absolute_expires timestamptz)
RETURNS uuid
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
  WITH consumed AS (
    UPDATE public.user_sessions AS s SET revoked_at = pg_catalog.now()
    WHERE s.id = p_pending_id AND s.revoked_at IS NULL AND s.rotated_at IS NULL
      AND s.mfa_verified_at IS NULL AND s.access_expires_at > pg_catalog.now()
      AND s.absolute_expires_at > pg_catalog.now()
    RETURNING s.user_id, s.absolute_expires_at, s.created_at)
  INSERT INTO public.user_sessions
    (user_id, family_id, access_hash, refresh_hash, access_expires_at, refresh_expires_at,
     absolute_expires_at, mfa_verified_at)
  SELECT c.user_id, pg_catalog.gen_random_uuid(), p_access_hash, p_refresh_hash,
         LEAST(p_access_expires, p_absolute_expires, c.absolute_expires_at),
         LEAST(p_refresh_expires, p_absolute_expires, c.absolute_expires_at),
         LEAST(p_absolute_expires, c.absolute_expires_at), pg_catalog.now()
  FROM consumed AS c
  WHERE EXISTS (SELECT 1 FROM public.users AS u WHERE u.id = c.user_id AND u.disabled_at IS NULL
                AND c.created_at >= u.sessions_valid_after)
  RETURNING id
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.revoke_user_sessions(p_user_id uuid)
RETURNS integer
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
  WITH stamp AS (
    UPDATE public.users SET sessions_valid_after = pg_catalog.clock_timestamp() WHERE id = p_user_id RETURNING 1),
  revoked AS (
    UPDATE public.user_sessions SET revoked_at = pg_catalog.now()
    WHERE user_id = p_user_id AND revoked_at IS NULL AND EXISTS (SELECT 1 FROM stamp) RETURNING 1)
  SELECT pg_catalog.count(*)::integer FROM revoked
$$;
--> statement-breakpoint
-- The throttle lock now outlives the window (a window that expires while the key is locked no longer resets it).
CREATE OR REPLACE FUNCTION public.auth_throttle_reserve(p_key text, p_max integer, p_window_seconds integer, p_lock_seconds integer)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  attempts integer;
BEGIN
  IF p_max < 1 OR p_window_seconds < 1 OR p_lock_seconds < 1 THEN
    RAISE EXCEPTION 'auth_throttle_reserve: limits must be positive';
  END IF;
  INSERT INTO public.auth_throttle AS t (key, failures, window_started_at, locked_until)
  VALUES (p_key, 1, pg_catalog.now(),
          CASE WHEN p_max <= 1 THEN pg_catalog.now() + pg_catalog.make_interval(secs => p_lock_seconds) END)
  ON CONFLICT (key) DO UPDATE SET
    failures = CASE
      WHEN (t.window_started_at + pg_catalog.make_interval(secs => p_window_seconds) <= pg_catalog.now()
         AND (t.locked_until IS NULL OR t.locked_until <= pg_catalog.now()))
        OR t.locked_until <= pg_catalog.now() THEN 1
      ELSE LEAST(t.failures + 1, p_max + 1) END,
    window_started_at = CASE
      WHEN (t.window_started_at + pg_catalog.make_interval(secs => p_window_seconds) <= pg_catalog.now()
         AND (t.locked_until IS NULL OR t.locked_until <= pg_catalog.now()))
        OR t.locked_until <= pg_catalog.now() THEN pg_catalog.now()
      ELSE t.window_started_at END,
    locked_until = CASE
      WHEN (t.window_started_at + pg_catalog.make_interval(secs => p_window_seconds) <= pg_catalog.now()
         AND (t.locked_until IS NULL OR t.locked_until <= pg_catalog.now()))
        OR t.locked_until <= pg_catalog.now() THEN
          CASE WHEN p_max <= 1 THEN pg_catalog.now() + pg_catalog.make_interval(secs => p_lock_seconds) END
      WHEN t.failures + 1 >= p_max THEN
        COALESCE(t.locked_until, pg_catalog.now() + pg_catalog.make_interval(secs => p_lock_seconds))
      ELSE t.locked_until END
  RETURNING t.failures INTO attempts;
  RETURN attempts <= p_max;
END;
$$;
--> statement-breakpoint
-- Consecutive second-factor failures per user, independent of the per-window throttle (re-review finding: 5 per
-- 15 minutes is ~480 guesses a day for an attacker who knows the password). The attempt is reserved atomically
-- BEFORE the code is checked, identified by the caller's live pending session (not a user id); only
-- mfa_attempt_succeeded resets the count; reaching the cap sets mfa_locked_at
-- and the user cannot verify again until an MFA reset removes the row (an owner/admin or the operator).
GRANT SELECT (user_id, consecutive_failures, mfa_locked_at), UPDATE (consecutive_failures, mfa_locked_at) ON "user_mfa" TO session_resolver;
--> statement-breakpoint
CREATE POLICY "session_resolver_mfa_attempts" ON "user_mfa" FOR ALL TO session_resolver USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE FUNCTION public.mfa_attempt_reserve(p_pending_hash text, p_cap integer)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  target uuid;
  attempts integer;
BEGIN
  IF p_cap < 1 THEN
    RAISE EXCEPTION 'mfa_attempt_reserve: cap must be positive';
  END IF;
  -- The user is resolved HERE from a live PENDING session identified by the hash of its secret token, never
  -- taken from the caller: whoever holds no pending token cannot count against, lock or reset another user.
  SELECT s.user_id INTO target
  FROM public.user_sessions AS s JOIN public.users AS u ON u.id = s.user_id
  WHERE s.access_hash = p_pending_hash AND s.mfa_verified_at IS NULL AND s.revoked_at IS NULL
    AND s.rotated_at IS NULL AND s.access_expires_at > pg_catalog.now()
    AND s.absolute_expires_at > pg_catalog.now() AND u.disabled_at IS NULL
    AND s.created_at >= u.sessions_valid_after;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  UPDATE public.user_mfa AS m SET
    consecutive_failures = LEAST(m.consecutive_failures + 1, p_cap + 1),
    mfa_locked_at = CASE WHEN m.consecutive_failures + 1 > p_cap THEN pg_catalog.now() ELSE NULL END
  WHERE m.user_id = target AND m.mfa_locked_at IS NULL
  RETURNING m.consecutive_failures INTO attempts;
  IF NOT FOUND THEN
    -- No row: nothing to guess (allowed); a locked row: refused.
    RETURN NOT EXISTS (SELECT 1 FROM public.user_mfa AS m WHERE m.user_id = target);
  END IF;
  RETURN attempts <= p_cap;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION public.mfa_attempt_succeeded(p_pending_hash text)
RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
  UPDATE public.user_mfa SET consecutive_failures = 0
  WHERE mfa_locked_at IS NULL AND user_id = (
    SELECT s.user_id FROM public.user_sessions AS s JOIN public.users AS u ON u.id = s.user_id
    WHERE s.access_hash = p_pending_hash AND s.mfa_verified_at IS NULL AND s.revoked_at IS NULL
      AND s.rotated_at IS NULL AND s.access_expires_at > pg_catalog.now()
      AND s.absolute_expires_at > pg_catalog.now() AND u.disabled_at IS NULL
      AND s.created_at >= u.sessions_valid_after)
$$;
--> statement-breakpoint
ALTER FUNCTION public.mfa_attempt_reserve(text, integer) OWNER TO session_resolver;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.mfa_attempt_reserve(text, integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.mfa_attempt_reserve(text, integer) TO app_user;
--> statement-breakpoint
ALTER FUNCTION public.mfa_attempt_succeeded(text) OWNER TO session_resolver;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.mfa_attempt_succeeded(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.mfa_attempt_succeeded(text) TO app_user;
