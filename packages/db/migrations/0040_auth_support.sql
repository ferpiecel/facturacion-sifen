CREATE TABLE "auth_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_id" uuid,
	"subject_hash" text,
	"event" varchar(64) NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_throttle" (
	"key" text PRIMARY KEY NOT NULL,
	"failures" integer DEFAULT 0 NOT NULL,
	"window_started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_until" timestamp with time zone,
	CONSTRAINT "auth_throttle_key_sha256" CHECK ("auth_throttle"."key" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "auth_events" ADD CONSTRAINT "auth_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
-- Both tables are global: FORCE RLS, no app_user grant. The session_resolver role of 0039 reaches them
-- only through the SECURITY DEFINER functions below.
ALTER TABLE "auth_throttle" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "auth_throttle" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "auth_events" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "auth_events" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "auth_throttle" TO session_resolver;
--> statement-breakpoint
GRANT INSERT ON "auth_events" TO session_resolver;
--> statement-breakpoint
GRANT SELECT ON "auth_events" TO platform_admin;
--> statement-breakpoint
CREATE POLICY "session_resolver_all" ON "auth_throttle" TO session_resolver USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY "session_resolver_insert" ON "auth_events" FOR INSERT TO session_resolver WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY "platform_admin_read" ON "auth_events" FOR SELECT TO platform_admin USING (true);
--> statement-breakpoint
GRANT SELECT (email, password_hash) ON "users" TO session_resolver;
--> statement-breakpoint
CREATE FUNCTION "auth_events_append_only"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'auth_events is append-only';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "auth_events_no_update_delete" BEFORE UPDATE OR DELETE ON "auth_events"
FOR EACH ROW EXECUTE FUNCTION "auth_events_append_only"();
--> statement-breakpoint
CREATE TRIGGER "auth_events_no_truncate" BEFORE TRUNCATE ON "auth_events"
FOR EACH STATEMENT EXECUTE FUNCTION "auth_events_append_only"();
--> statement-breakpoint
CREATE FUNCTION public.auth_throttle_locked(p_key text)
RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
  SELECT EXISTS (SELECT 1 FROM public.auth_throttle AS t WHERE t.key = p_key AND t.locked_until > pg_catalog.now())
$$;
--> statement-breakpoint
-- Counts one failure atomically (a single upsert, so concurrent attempts cannot undercount) and locks the
-- key for p_lock_seconds once p_max failures fall inside one window of p_window_seconds. Returns whether
-- the key is now locked.
CREATE FUNCTION public.auth_throttle_fail(p_key text, p_max integer, p_window_seconds integer, p_lock_seconds integer)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  is_locked boolean;
BEGIN
  INSERT INTO public.auth_throttle AS t (key, failures, window_started_at, locked_until)
  VALUES (p_key, 1, pg_catalog.now(),
          CASE WHEN p_max <= 1 THEN pg_catalog.now() + pg_catalog.make_interval(secs => p_lock_seconds) END)
  ON CONFLICT (key) DO UPDATE SET
    failures = CASE WHEN t.window_started_at + pg_catalog.make_interval(secs => p_window_seconds) <= pg_catalog.now()
                    THEN 1 ELSE t.failures + 1 END,
    window_started_at = CASE WHEN t.window_started_at + pg_catalog.make_interval(secs => p_window_seconds) <= pg_catalog.now()
                             THEN pg_catalog.now() ELSE t.window_started_at END,
    locked_until = CASE
      WHEN (CASE WHEN t.window_started_at + pg_catalog.make_interval(secs => p_window_seconds) <= pg_catalog.now()
                 THEN 1 ELSE t.failures + 1 END) >= p_max
      THEN pg_catalog.now() + pg_catalog.make_interval(secs => p_lock_seconds)
      ELSE t.locked_until END
  RETURNING t.locked_until > pg_catalog.now() INTO is_locked;
  RETURN COALESCE(is_locked, false);
END;
$$;
--> statement-breakpoint
CREATE FUNCTION public.auth_throttle_clear(p_key text)
RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$ DELETE FROM public.auth_throttle WHERE key = p_key $$;
--> statement-breakpoint
CREATE FUNCTION public.record_auth_event(p_user_id uuid, p_subject_hash text, p_event text, p_detail jsonb)
RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
  INSERT INTO public.auth_events (user_id, subject_hash, event, detail) VALUES (p_user_id, p_subject_hash, p_event, p_detail)
$$;
--> statement-breakpoint
CREATE FUNCTION public.resolve_user_credentials(p_email text)
RETURNS TABLE (id uuid, password_hash text, disabled boolean)
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
  SELECT u.id, u.password_hash, u.disabled_at IS NOT NULL FROM public.users AS u WHERE u.email = p_email
$$;
--> statement-breakpoint
ALTER FUNCTION public.auth_throttle_locked(text) OWNER TO session_resolver;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.auth_throttle_locked(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.auth_throttle_locked(text) TO app_user;
--> statement-breakpoint
ALTER FUNCTION public.auth_throttle_fail(text, integer, integer, integer) OWNER TO session_resolver;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.auth_throttle_fail(text, integer, integer, integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.auth_throttle_fail(text, integer, integer, integer) TO app_user;
--> statement-breakpoint
ALTER FUNCTION public.auth_throttle_clear(text) OWNER TO session_resolver;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.auth_throttle_clear(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.auth_throttle_clear(text) TO app_user;
--> statement-breakpoint
ALTER FUNCTION public.record_auth_event(uuid, text, text, jsonb) OWNER TO session_resolver;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.record_auth_event(uuid, text, text, jsonb) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.record_auth_event(uuid, text, text, jsonb) TO app_user;
--> statement-breakpoint
ALTER FUNCTION public.resolve_user_credentials(text) OWNER TO session_resolver;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.resolve_user_credentials(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.resolve_user_credentials(text) TO app_user;
