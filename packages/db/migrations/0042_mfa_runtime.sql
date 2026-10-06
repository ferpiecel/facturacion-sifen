-- The runtime (app_user) verifies an MFA code without platform_admin: it reads the enrolment and spends a
-- TOTP step or a recovery code only through SECURITY DEFINER functions of the narrow session_resolver role
-- (same pattern as 0039-0041). The role gets only the columns these functions touch.
GRANT SELECT (sealed, confirmed_at, last_used_step, recovery_hashes), UPDATE (last_used_step, recovery_hashes) ON "user_mfa" TO session_resolver;
--> statement-breakpoint
CREATE FUNCTION public.mfa_find(p_user_id uuid)
RETURNS TABLE (sealed jsonb, confirmed_at timestamptz, last_used_step bigint, recovery_hashes text[])
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
  SELECT m.sealed, m.confirmed_at, m.last_used_step, m.recovery_hashes FROM public.user_mfa AS m WHERE m.user_id = p_user_id
$$;
--> statement-breakpoint
-- Replay guard: records the step only if it is newer; a single conditional UPDATE (compare-and-set).
CREATE FUNCTION public.mfa_advance_step(p_user_id uuid, p_step bigint)
RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
  WITH advanced AS (
    UPDATE public.user_mfa SET last_used_step = p_step
    WHERE user_id = p_user_id AND confirmed_at IS NOT NULL AND mfa_locked_at IS NULL
      AND (last_used_step IS NULL OR last_used_step < p_step)
    RETURNING 1)
  SELECT EXISTS (SELECT 1 FROM advanced)
$$;
--> statement-breakpoint
-- Spends one recovery code: removes the hash only if it is still there (single-use under concurrency).
CREATE FUNCTION public.mfa_consume_recovery_code(p_user_id uuid, p_hash text)
RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
  WITH spent AS (
    UPDATE public.user_mfa SET recovery_hashes = pg_catalog.array_remove(recovery_hashes, p_hash)
    WHERE user_id = p_user_id AND confirmed_at IS NOT NULL AND mfa_locked_at IS NULL AND p_hash = ANY (recovery_hashes)
    RETURNING 1)
  SELECT EXISTS (SELECT 1 FROM spent)
$$;
--> statement-breakpoint
ALTER FUNCTION public.mfa_find(uuid) OWNER TO session_resolver;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.mfa_find(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.mfa_find(uuid) TO app_user;
--> statement-breakpoint
ALTER FUNCTION public.mfa_advance_step(uuid, bigint) OWNER TO session_resolver;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.mfa_advance_step(uuid, bigint) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.mfa_advance_step(uuid, bigint) TO app_user;
--> statement-breakpoint
ALTER FUNCTION public.mfa_consume_recovery_code(uuid, text) OWNER TO session_resolver;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.mfa_consume_recovery_code(uuid, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.mfa_consume_recovery_code(uuid, text) TO app_user;
