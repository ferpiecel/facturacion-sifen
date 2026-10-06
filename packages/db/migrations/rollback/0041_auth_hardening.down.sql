-- Manual rollback for 0041: restores the 0039/0040 function bodies, then drops what 0041 added.
CREATE OR REPLACE FUNCTION public.resolve_user_session(p_access_hash text)
RETURNS TABLE (id uuid, user_id uuid, active_tenant_id uuid, mfa_verified_at timestamptz,
  access_expires_at timestamptz, refresh_expires_at timestamptz)
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
  SELECT s.id, s.user_id, s.active_tenant_id, s.mfa_verified_at, s.access_expires_at, s.refresh_expires_at
  FROM public.user_sessions AS s
  WHERE s.access_hash = p_access_hash AND s.rotated_at IS NULL AND s.revoked_at IS NULL
    AND s.access_expires_at > pg_catalog.now() AND s.absolute_expires_at > pg_catalog.now()
    AND EXISTS (SELECT 1 FROM public.users AS u WHERE u.id = s.user_id AND u.disabled_at IS NULL)
$$;
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
    RETURNING n.id, n.user_id, n.active_tenant_id, n.mfa_verified_at, n.access_expires_at,
              n.refresh_expires_at;
END;
$$;
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
    RETURNING s.user_id)
  INSERT INTO public.user_sessions
    (user_id, family_id, access_hash, refresh_hash, access_expires_at, refresh_expires_at,
     absolute_expires_at, mfa_verified_at)
  SELECT c.user_id, pg_catalog.gen_random_uuid(), p_access_hash, p_refresh_hash,
         LEAST(p_access_expires, p_absolute_expires), LEAST(p_refresh_expires, p_absolute_expires),
         p_absolute_expires, pg_catalog.now()
  FROM consumed AS c
  WHERE EXISTS (SELECT 1 FROM public.users AS u WHERE u.id = c.user_id AND u.disabled_at IS NULL)
  RETURNING id
$$;
CREATE OR REPLACE FUNCTION public.revoke_user_sessions(p_user_id uuid)
RETURNS integer
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
  WITH revoked AS (
    UPDATE public.user_sessions SET revoked_at = pg_catalog.now()
    WHERE user_id = p_user_id AND revoked_at IS NULL RETURNING 1)
  SELECT pg_catalog.count(*)::integer FROM revoked
$$;
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
      WHEN t.window_started_at + pg_catalog.make_interval(secs => p_window_seconds) <= pg_catalog.now()
        OR t.locked_until <= pg_catalog.now() THEN 1
      ELSE LEAST(t.failures + 1, p_max + 1) END,
    window_started_at = CASE
      WHEN t.window_started_at + pg_catalog.make_interval(secs => p_window_seconds) <= pg_catalog.now()
        OR t.locked_until <= pg_catalog.now() THEN pg_catalog.now()
      ELSE t.window_started_at END,
    locked_until = CASE
      WHEN t.window_started_at + pg_catalog.make_interval(secs => p_window_seconds) <= pg_catalog.now()
        OR t.locked_until <= pg_catalog.now() THEN
          CASE WHEN p_max <= 1 THEN pg_catalog.now() + pg_catalog.make_interval(secs => p_lock_seconds) END
      WHEN t.failures + 1 >= p_max THEN
        COALESCE(t.locked_until, pg_catalog.now() + pg_catalog.make_interval(secs => p_lock_seconds))
      ELSE t.locked_until END
  RETURNING t.failures INTO attempts;
  RETURN attempts <= p_max;
END;
$$;
DROP FUNCTION IF EXISTS public.mfa_attempt_succeeded(uuid);
DROP FUNCTION IF EXISTS public.mfa_attempt_reserve(uuid, integer);
DROP POLICY IF EXISTS "session_resolver_mfa_attempts" ON "user_mfa";
REVOKE SELECT (user_id, consecutive_failures, mfa_locked_at), UPDATE (consecutive_failures, mfa_locked_at) ON "user_mfa" FROM session_resolver;
DROP POLICY IF EXISTS "session_resolver_stamp" ON "users";
REVOKE SELECT (sessions_valid_after), UPDATE (sessions_valid_after) ON "users" FROM session_resolver;
ALTER TABLE "user_mfa" DROP COLUMN IF EXISTS "mfa_locked_at";
ALTER TABLE "user_mfa" DROP COLUMN IF EXISTS "consecutive_failures";
ALTER TABLE "users" DROP COLUMN IF EXISTS "sessions_valid_after";
