CREATE TABLE "partner_memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"partner_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "partner_memberships_partner_id_user_id_key" UNIQUE("partner_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "partner_memberships" ADD CONSTRAINT "partner_memberships_partner_id_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partners"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_memberships" ADD CONSTRAINT "partner_memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "partner_memberships_user_id_idx" ON "partner_memberships" USING btree ("user_id");--> statement-breakpoint
-- HU-E1-06 / ADR-0014. partner_memberships is global like users: FORCE RLS, no app_user grant.
ALTER TABLE "partner_memberships" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "partner_memberships" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON "partner_memberships" TO platform_admin;
--> statement-breakpoint
CREATE POLICY "platform_admin_all" ON "partner_memberships" TO platform_admin USING (true) WITH CHECK (true);
--> statement-breakpoint
GRANT SELECT (partner_id, user_id) ON "partner_memberships" TO session_resolver;
--> statement-breakpoint
CREATE POLICY "session_resolver_read" ON "partner_memberships" FOR SELECT TO session_resolver USING (true);
--> statement-breakpoint
CREATE FUNCTION public.user_in_partner(p_user_id uuid, p_partner_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
  SELECT EXISTS (SELECT 1 FROM public.partner_memberships AS m
    WHERE m.user_id OPERATOR(pg_catalog.=) p_user_id AND m.partner_id OPERATOR(pg_catalog.=) p_partner_id)
$$;
--> statement-breakpoint
ALTER FUNCTION public.user_in_partner(uuid, uuid) OWNER TO session_resolver;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.user_in_partner(uuid, uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.user_in_partner(uuid, uuid) TO app_user;
--> statement-breakpoint
-- partner_viewer: the partner's runtime role (app_login does SET LOCAL ROLE). Row policies key on
-- app.current_partner; COLUMN grants keep document content and certificate secrets unreachable. Read-only.
LOCK TABLE pg_catalog.pg_authid IN SHARE ROW EXCLUSIVE MODE;
--> statement-breakpoint
DO $$
DECLARE
  membership record;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'partner_viewer') THEN
    CREATE ROLE partner_viewer;
  END IF;
  ALTER ROLE partner_viewer NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION NOLOGIN;
  FOR membership IN
    SELECT m.roleid::regrole::text AS granted, m.member::regrole::text AS member
    FROM pg_auth_members m
    WHERE m.member = 'partner_viewer'::regrole OR m.roleid = 'partner_viewer'::regrole
  LOOP
    EXECUTE format('REVOKE %s FROM %s', membership.granted, membership.member);
  END LOOP;
END
$$;
--> statement-breakpoint
GRANT partner_viewer TO app_login;
--> statement-breakpoint
GRANT SELECT (id, name, partner_id, environment, created_at) ON "tenants" TO partner_viewer;
--> statement-breakpoint
CREATE POLICY "partner_read" ON "tenants" FOR SELECT TO partner_viewer
  USING (partner_id = nullif(current_setting('app.current_partner', true), '')::uuid);
--> statement-breakpoint
GRANT SELECT (tenant_id, environment, status, not_before, not_after) ON "tenant_certificates" TO partner_viewer;
--> statement-breakpoint
CREATE POLICY "partner_read" ON "tenant_certificates" FOR SELECT TO partner_viewer
  USING (EXISTS (SELECT 1 FROM "tenants" AS t WHERE t.id = tenant_id
    AND t.partner_id = nullif(current_setting('app.current_partner', true), '')::uuid));
--> statement-breakpoint
GRANT SELECT (tenant_id, environment, status) ON "documents" TO partner_viewer;
--> statement-breakpoint
CREATE POLICY "partner_read" ON "documents" FOR SELECT TO partner_viewer
  USING (EXISTS (SELECT 1 FROM "tenants" AS t WHERE t.id = tenant_id
    AND t.partner_id = nullif(current_setting('app.current_partner', true), '')::uuid));
