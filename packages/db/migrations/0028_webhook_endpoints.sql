CREATE TABLE "webhook_endpoints" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"url" text NOT NULL,
	"events" text[] DEFAULT '{}'::text[] NOT NULL,
	"sealed" jsonb NOT NULL,
	"secret_version" integer DEFAULT 1 NOT NULL,
	"previous_sealed" jsonb,
	"previous_expires_at" timestamp with time zone,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "webhook_endpoints_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "webhook_endpoints_url_https" CHECK ("webhook_endpoints"."url" ~ '^https://[^[:space:]]+$' AND "webhook_endpoints"."url" !~ '^https://[^/]*@' AND length("webhook_endpoints"."url") <= 2048),
	CONSTRAINT "webhook_endpoints_events_valid" CHECK ("webhook_endpoints"."events" <@ ARRAY['document.created', 'document.signed', 'document.submitted', 'document.approved', 'document.approved_with_observations', 'document.rejected', 'document.cancelled', 'document.number_voided', 'document.transmission_deadline_warning', 'document.notification.delivered', 'document.notification.failed']::text[]),
	CONSTRAINT "webhook_endpoints_previous_pair" CHECK (("webhook_endpoints"."previous_sealed" IS NULL) = ("webhook_endpoints"."previous_expires_at" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE FUNCTION "webhook_endpoints_guard"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'webhook_endpoints: identity columns are immutable';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "webhook_endpoints_guard" BEFORE UPDATE ON "webhook_endpoints"
FOR EACH ROW EXECUTE FUNCTION "webhook_endpoints_guard"();
--> statement-breakpoint
-- RLS + grants (same pattern as 0022): the API registers endpoints as app_user inside a tenant
-- transaction; no DELETE (an endpoint is disabled, its deliveries keep referencing it).
ALTER TABLE "webhook_endpoints" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "webhook_endpoints" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "webhook_endpoints" TO app_user;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "webhook_endpoints" TO platform_admin;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "webhook_endpoints"
  TO app_user
  USING (tenant_id = nullif(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.current_tenant', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "platform_admin_all" ON "webhook_endpoints"
  TO platform_admin
  USING (true)
  WITH CHECK (true);
