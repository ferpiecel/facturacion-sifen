-- The runtime (app_user) enrols MFA for the user behind a live PENDING session, only through SECURITY DEFINER
-- functions of session_resolver (same pattern as 0042). Every function resolves its user via mfa_pending_user
-- and takes no user id, so a caller can only enrol the user it holds a pending token for. Writes to an already
-- confirmed enrolment are refused here (and by the user_mfa_guard trigger): a reset is an operator action.
GRANT INSERT (user_id, sealed), UPDATE (sealed, confirmed_at) ON "user_mfa" TO session_resolver;
--> statement-breakpoint
-- The account label shown by the authenticator app: the email of the pending user.
CREATE FUNCTION public.mfa_account(p_pending_hash text)
RETURNS text
LANGUAGE sql SECURITY DEFINER STABLE SET search_path = pg_catalog, pg_temp
AS $$
  SELECT u.email FROM public.users AS u WHERE u.id = public.mfa_pending_user(p_pending_hash)
$$;
--> statement-breakpoint
-- Creates or replaces the UNCONFIRMED enrolment; false when there is no live pending session or MFA is confirmed.
CREATE FUNCTION public.mfa_save_pending(p_pending_hash text, p_sealed jsonb)
RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
  WITH saved AS (
    INSERT INTO public.user_mfa (user_id, sealed)
    SELECT p.user_id, p_sealed FROM (SELECT public.mfa_pending_user(p_pending_hash) AS user_id) AS p
    WHERE p.user_id IS NOT NULL
    ON CONFLICT (user_id) DO UPDATE SET sealed = EXCLUDED.sealed WHERE user_mfa.confirmed_at IS NULL
    RETURNING 1)
  SELECT EXISTS (SELECT 1 FROM saved)
$$;
--> statement-breakpoint
-- Confirms the pending enrolment with the first accepted step and the recovery-code hashes, only if its secret
-- is still the one the code was checked against (a concurrent enrolment may have replaced it).
CREATE FUNCTION public.mfa_confirm(p_pending_hash text, p_step bigint, p_hashes text[], p_expected jsonb)
RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
  WITH confirmed AS (
    UPDATE public.user_mfa SET confirmed_at = pg_catalog.now(), last_used_step = p_step, recovery_hashes = p_hashes
    WHERE user_id = public.mfa_pending_user(p_pending_hash) AND confirmed_at IS NULL AND sealed = p_expected
    RETURNING 1)
  SELECT EXISTS (SELECT 1 FROM confirmed)
$$;
--> statement-breakpoint
ALTER FUNCTION public.mfa_account(text) OWNER TO session_resolver;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.mfa_account(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.mfa_account(text) TO app_user;
--> statement-breakpoint
ALTER FUNCTION public.mfa_save_pending(text, jsonb) OWNER TO session_resolver;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.mfa_save_pending(text, jsonb) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.mfa_save_pending(text, jsonb) TO app_user;
--> statement-breakpoint
ALTER FUNCTION public.mfa_confirm(text, bigint, text[], jsonb) OWNER TO session_resolver;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.mfa_confirm(text, bigint, text[], jsonb) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.mfa_confirm(text, bigint, text[], jsonb) TO app_user;
