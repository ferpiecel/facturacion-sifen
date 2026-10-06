-- Manual rollback for 0040 (functions, triggers, policies and grants hand-written there, then the tables).
DROP FUNCTION IF EXISTS public.auth_throttle_locked(text);
DROP FUNCTION IF EXISTS public.auth_throttle_fail(text, integer, integer, integer);
DROP FUNCTION IF EXISTS public.auth_throttle_clear(text);
DROP FUNCTION IF EXISTS public.record_auth_event(uuid, text, text, jsonb);
DROP FUNCTION IF EXISTS public.resolve_user_credentials(text);
DROP TRIGGER IF EXISTS "auth_events_no_truncate" ON "auth_events";
DROP TRIGGER IF EXISTS "auth_events_no_update_delete" ON "auth_events";
DROP FUNCTION IF EXISTS "auth_events_append_only"();
DROP POLICY IF EXISTS "platform_admin_read" ON "auth_events";
DROP POLICY IF EXISTS "session_resolver_insert" ON "auth_events";
DROP POLICY IF EXISTS "session_resolver_all" ON "auth_throttle";
REVOKE SELECT (email, password_hash) ON "users" FROM session_resolver;
REVOKE ALL ON "auth_events" FROM session_resolver, platform_admin;
REVOKE ALL ON "auth_throttle" FROM session_resolver;
DROP TABLE IF EXISTS "auth_events";
DROP TABLE IF EXISTS "auth_throttle";
