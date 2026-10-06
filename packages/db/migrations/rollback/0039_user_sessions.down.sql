-- Manual rollback for 0039 (functions, policies, grants and the resolver role hand-written there, then the table).
DROP FUNCTION IF EXISTS public.create_user_session(uuid, text, text, timestamptz, timestamptz, timestamptz, boolean);
DROP FUNCTION IF EXISTS public.resolve_user_session(text);
DROP FUNCTION IF EXISTS public.rotate_user_session(text, text, text, timestamptz, timestamptz);
DROP FUNCTION IF EXISTS public.revoke_user_session(uuid);
DROP FUNCTION IF EXISTS public.revoke_user_sessions(uuid);
DROP FUNCTION IF EXISTS public.list_user_memberships(uuid);
DROP FUNCTION IF EXISTS public.set_user_session_tenant(uuid, uuid);
DROP POLICY IF EXISTS "session_resolver_read" ON "tenants";
DROP POLICY IF EXISTS "session_resolver_read" ON "tenant_memberships";
DROP POLICY IF EXISTS "session_resolver_read" ON "users";
DROP POLICY IF EXISTS "platform_admin_all" ON "user_sessions";
DROP POLICY IF EXISTS "session_resolver_all" ON "user_sessions";
REVOKE ALL ON "tenants" FROM session_resolver;
REVOKE ALL ON "tenant_memberships" FROM session_resolver;
REVOKE ALL ON "users" FROM session_resolver;
REVOKE ALL ON "user_sessions" FROM session_resolver, platform_admin;
DROP TABLE IF EXISTS "user_sessions";
DROP ROLE IF EXISTS session_resolver;
