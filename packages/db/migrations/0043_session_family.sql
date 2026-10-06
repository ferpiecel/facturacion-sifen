-- Logout by refresh token (HU-E1-07): the holder of any refresh token of a session family, current or already
-- rotated, can end the whole family without a valid access token. Returns how many generations were revoked.
CREATE FUNCTION public.revoke_session_family(p_refresh_hash text)
RETURNS integer
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
  WITH revoked AS (
    UPDATE public.user_sessions SET revoked_at = pg_catalog.now()
    WHERE revoked_at IS NULL AND family_id = (
      SELECT f.family_id FROM public.user_sessions AS f WHERE f.refresh_hash = p_refresh_hash)
    RETURNING 1)
  SELECT pg_catalog.count(*)::integer FROM revoked
$$;
--> statement-breakpoint
ALTER FUNCTION public.revoke_session_family(text) OWNER TO session_resolver;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.revoke_session_family(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.revoke_session_family(text) TO app_user;
