-- The runtime (app_user) verifies an MFA code without platform_admin: it reads the enrolment and spends a
-- TOTP step or a recovery code only through SECURITY DEFINER functions of the narrow session_resolver role
-- (same pattern as 0039-0041). The role gets only the columns these functions touch.
GRANT SELECT (sealed, confirmed_at, last_used_step, recovery_hashes), UPDATE (last_used_step, recovery_hashes) ON "user_mfa" TO session_resolver;
--> statement-breakpoint
-- The user behind a live PENDING session, identified by the SHA-256 of its secret token. Internal: not granted
-- to app_user. Every function below resolves its user through it and takes no user id, so a caller (or a
-- compromised runtime) can only act on a user it holds a live pending token for.
CREATE FUNCTION public.mfa_pending_user(p_pending_hash text)
RETURNS uuid
LANGUAGE sql SECURITY DEFINER STABLE SET search_path = pg_catalog, pg_temp
AS $$
  SELECT s.user_id FROM public.user_sessions AS s JOIN public.users AS u ON u.id = s.user_id
  WHERE s.access_hash = p_pending_hash AND s.mfa_verified_at IS NULL AND s.revoked_at IS NULL
    AND s.rotated_at IS NULL AND s.access_expires_at > pg_catalog.now()
    AND s.absolute_expires_at > pg_catalog.now() AND u.disabled_at IS NULL
    AND s.created_at >= u.sessions_valid_after
$$;
--> statement-breakpoint
CREATE FUNCTION public.mfa_find(p_pending_hash text)
RETURNS TABLE (sealed jsonb, confirmed_at timestamptz, last_used_step bigint, recovery_hashes text[])
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
  SELECT m.sealed, m.confirmed_at, m.last_used_step, m.recovery_hashes FROM public.user_mfa AS m
  WHERE m.user_id = public.mfa_pending_user(p_pending_hash)
$$;
--> statement-breakpoint
-- Replay guard: records the step only if it is newer; a single conditional UPDATE (compare-and-set).
CREATE FUNCTION public.mfa_advance_step(p_pending_hash text, p_step bigint)
RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
  WITH advanced AS (
    UPDATE public.user_mfa SET last_used_step = p_step
    WHERE user_id = public.mfa_pending_user(p_pending_hash) AND confirmed_at IS NOT NULL AND mfa_locked_at IS NULL
      AND (last_used_step IS NULL OR last_used_step < p_step)
    RETURNING 1)
  SELECT EXISTS (SELECT 1 FROM advanced)
$$;
--> statement-breakpoint
-- Spends one recovery code: removes the hash only if it is still there (single-use under concurrency).
CREATE FUNCTION public.mfa_consume_recovery_code(p_pending_hash text, p_hash text)
RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
  WITH spent AS (
    UPDATE public.user_mfa SET recovery_hashes = pg_catalog.array_remove(recovery_hashes, p_hash)
    WHERE user_id = public.mfa_pending_user(p_pending_hash) AND confirmed_at IS NOT NULL AND mfa_locked_at IS NULL
      AND p_hash = ANY (recovery_hashes)
    RETURNING 1)
  SELECT EXISTS (SELECT 1 FROM spent)
$$;
--> statement-breakpoint
ALTER FUNCTION public.mfa_find(text) OWNER TO session_resolver;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.mfa_find(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.mfa_find(text) TO app_user;
--> statement-breakpoint
ALTER FUNCTION public.mfa_advance_step(text, bigint) OWNER TO session_resolver;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.mfa_advance_step(text, bigint) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.mfa_advance_step(text, bigint) TO app_user;
--> statement-breakpoint
ALTER FUNCTION public.mfa_consume_recovery_code(text, text) OWNER TO session_resolver;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.mfa_consume_recovery_code(text, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.mfa_consume_recovery_code(text, text) TO app_user;
--> statement-breakpoint
ALTER FUNCTION public.mfa_pending_user(text) OWNER TO session_resolver;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.mfa_pending_user(text) FROM PUBLIC;
