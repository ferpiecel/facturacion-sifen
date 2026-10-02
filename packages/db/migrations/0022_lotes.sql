ALTER TABLE "documents" ADD CONSTRAINT "documents_tenant_id_key" UNIQUE("tenant_id","id");
--> statement-breakpoint
CREATE TABLE "lote_documents" (
	"lote_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	CONSTRAINT "lote_documents_lote_id_document_id_pk" PRIMARY KEY("lote_id","document_id")
);
--> statement-breakpoint
CREATE TABLE "lotes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"environment" "tenant_environment" NOT NULL,
	"document_type" smallint NOT NULL,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"sifen_protocol" varchar(64),
	"response_code" varchar(8),
	"response_message" text,
	"sent_at" timestamp with time zone,
	"next_poll_at" timestamp with time zone,
	"poll_deadline_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lotes_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "lotes_document_type_range" CHECK ("lotes"."document_type" BETWEEN 1 AND 8),
	CONSTRAINT "lotes_status_valid" CHECK ("lotes"."status" IN ('pending', 'sending', 'sent', 'rejected', 'unknown'))
);
--> statement-breakpoint
ALTER TABLE "lote_documents" ADD CONSTRAINT "lote_documents_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lote_documents" ADD CONSTRAINT "lote_documents_tenant_lote_fk" FOREIGN KEY ("tenant_id","lote_id") REFERENCES "public"."lotes"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lote_documents" ADD CONSTRAINT "lote_documents_tenant_document_fk" FOREIGN KEY ("tenant_id","document_id") REFERENCES "public"."documents"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lotes" ADD CONSTRAINT "lotes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
--> statement-breakpoint
CREATE FUNCTION "lotes_guard"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  tenant_env public.tenant_environment;
BEGIN
  -- A tenant row hidden by RLS is left to the row-level security policy.
  SELECT t.environment INTO tenant_env FROM public.tenants t WHERE t.id = NEW.tenant_id;
  IF FOUND AND tenant_env IS DISTINCT FROM NEW.environment THEN
    RAISE EXCEPTION 'lotes: environment must match the tenant''s current environment';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.id IS DISTINCT FROM OLD.id
      OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
      OR NEW.environment IS DISTINCT FROM OLD.environment
      OR NEW.document_type IS DISTINCT FROM OLD.document_type
      OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'lotes: identity columns are immutable';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "lotes_guard" BEFORE INSERT OR UPDATE ON "lotes"
FOR EACH ROW EXECUTE FUNCTION "lotes_guard"();
--> statement-breakpoint
-- RLS + grants (same pattern as 0021; no DELETE: lotes are transmission records).
ALTER TABLE "lotes" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "lotes" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "lotes" TO app_user;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "lotes" TO platform_admin;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "lotes"
  TO app_user
  USING (tenant_id = nullif(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.current_tenant', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "platform_admin_all" ON "lotes"
  TO platform_admin
  USING (true)
  WITH CHECK (true);
--> statement-breakpoint
ALTER TABLE "lote_documents" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "lote_documents" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT ON "lote_documents" TO app_user;
--> statement-breakpoint
GRANT SELECT, INSERT ON "lote_documents" TO platform_admin;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "lote_documents"
  TO app_user
  USING (tenant_id = nullif(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.current_tenant', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "platform_admin_all" ON "lote_documents"
  TO platform_admin
  USING (true)
  WITH CHECK (true);
