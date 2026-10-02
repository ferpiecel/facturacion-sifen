CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"environment" "tenant_environment" NOT NULL,
	"cdc" char(44) NOT NULL,
	"document_type" smallint NOT NULL,
	"timbrado_id" uuid NOT NULL,
	"establishment_id" uuid NOT NULL,
	"expedition_point_id" uuid NOT NULL,
	"series" varchar(2) DEFAULT '' NOT NULL,
	"number" integer NOT NULL,
	"security_code" char(9) NOT NULL,
	"status" varchar(32) DEFAULT 'accepted' NOT NULL,
	"receiver_ruc" varchar(15),
	"issued_at" timestamp with time zone NOT NULL,
	"total_amount" numeric(23, 8) NOT NULL,
	"currency" char(3) DEFAULT 'PYG' NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "documents_tenant_environment_cdc_key" UNIQUE("tenant_id","environment","cdc"),
	CONSTRAINT "documents_sequence_number_key" UNIQUE("tenant_id","environment","timbrado_id","establishment_id","expedition_point_id","document_type","series","number"),
	CONSTRAINT "documents_cdc_format" CHECK ("documents"."cdc" ~ '^[0-9]{44}$'),
	CONSTRAINT "documents_security_code_format" CHECK ("documents"."security_code" ~ '^[0-9]{9}$'),
	CONSTRAINT "documents_number_range" CHECK ("documents"."number" BETWEEN 1 AND 9999999),
	CONSTRAINT "documents_document_type_range" CHECK ("documents"."document_type" BETWEEN 1 AND 8),
	CONSTRAINT "documents_series_format" CHECK ("documents"."series" = '' OR "documents"."series" ~ '^[A-Z]{2}$'),
	CONSTRAINT "documents_status_valid" CHECK ("documents"."status" IN ('accepted', 'signed', 'queued', 'submitted', 'approved', 'approved_with_observations', 'rejected', 'corrected', 'number_voided', 'cancelled'))
);
--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_tenant_timbrado_fk" FOREIGN KEY ("tenant_id","timbrado_id") REFERENCES "public"."tenant_timbrados"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_tenant_point_fk" FOREIGN KEY ("tenant_id","establishment_id","expedition_point_id") REFERENCES "public"."tenant_expedition_points"("tenant_id","establishment_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE FUNCTION "documents_immutable_identity"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.environment IS DISTINCT FROM OLD.environment
    OR NEW.cdc IS DISTINCT FROM OLD.cdc
    OR NEW.document_type IS DISTINCT FROM OLD.document_type
    OR NEW.timbrado_id IS DISTINCT FROM OLD.timbrado_id
    OR NEW.establishment_id IS DISTINCT FROM OLD.establishment_id
    OR NEW.expedition_point_id IS DISTINCT FROM OLD.expedition_point_id
    OR NEW.series IS DISTINCT FROM OLD.series
    OR NEW.number IS DISTINCT FROM OLD.number
    OR NEW.security_code IS DISTINCT FROM OLD.security_code
    OR NEW.issued_at IS DISTINCT FROM OLD.issued_at
    OR NEW.total_amount IS DISTINCT FROM OLD.total_amount
    OR NEW.payload IS DISTINCT FROM OLD.payload THEN
    RAISE EXCEPTION 'documents: identity columns are immutable';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "documents_immutable_identity" BEFORE UPDATE ON "documents"
FOR EACH ROW EXECUTE FUNCTION "documents_immutable_identity"();
--> statement-breakpoint
-- RLS + grants for documents (same pattern as 0012; no DELETE: fiscal documents are never deleted).
ALTER TABLE "documents" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "documents" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "documents" TO app_user;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "documents" TO platform_admin;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "documents"
  TO app_user
  USING (tenant_id = nullif(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.current_tenant', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "platform_admin_all" ON "documents"
  TO platform_admin
  USING (true)
  WITH CHECK (true);
