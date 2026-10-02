CREATE TABLE "tenant_certificates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"environment" "tenant_environment" NOT NULL,
	"sealed" jsonb NOT NULL,
	"fingerprint" char(64) NOT NULL,
	"subject_ruc" varchar(12) NOT NULL,
	"not_before" timestamp with time zone NOT NULL,
	"not_after" timestamp with time zone NOT NULL,
	"status" varchar(16) DEFAULT 'active' NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenant_certificates_tenant_environment_fingerprint_key" UNIQUE("tenant_id","environment","fingerprint"),
	CONSTRAINT "tenant_certificates_fingerprint_format" CHECK ("tenant_certificates"."fingerprint" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "tenant_certificates_status_valid" CHECK ("tenant_certificates"."status" IN ('active', 'revoked')),
	CONSTRAINT "tenant_certificates_revoked_pair" CHECK (("tenant_certificates"."status" = 'revoked') = ("tenant_certificates"."revoked_at" IS NOT NULL)),
	CONSTRAINT "tenant_certificates_validity_order" CHECK ("tenant_certificates"."not_before" < "tenant_certificates"."not_after")
);
--> statement-breakpoint
ALTER TABLE "tenant_certificates" ADD CONSTRAINT "tenant_certificates_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_certificates_one_active_idx" ON "tenant_certificates" USING btree ("tenant_id","environment") WHERE "tenant_certificates"."status" = 'active';
--> statement-breakpoint
-- Everything but the status is immutable; a certificate is only ever revoked, once.
CREATE FUNCTION "tenant_certificates_guard"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.environment IS DISTINCT FROM OLD.environment
    OR NEW.sealed IS DISTINCT FROM OLD.sealed
    OR NEW.fingerprint IS DISTINCT FROM OLD.fingerprint
    OR NEW.subject_ruc IS DISTINCT FROM OLD.subject_ruc
    OR NEW.not_before IS DISTINCT FROM OLD.not_before
    OR NEW.not_after IS DISTINCT FROM OLD.not_after
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'tenant_certificates: identity and sealed columns are immutable';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status
    AND NOT (OLD.status = 'active' AND NEW.status = 'revoked') THEN
    RAISE EXCEPTION 'tenant_certificates: invalid status transition % -> %', OLD.status, NEW.status;
  END IF;
  IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
    RAISE EXCEPTION 'tenant_certificates: revoked_at is immutable once set';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "tenant_certificates_guard" BEFORE UPDATE ON "tenant_certificates"
FOR EACH ROW EXECUTE FUNCTION "tenant_certificates_guard"();
--> statement-breakpoint
-- RLS + grants (same pattern as 0020): app_user reads under the tenant's scope; the operator
-- (platform_admin) adds and revokes; nobody deletes.
ALTER TABLE "tenant_certificates" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "tenant_certificates" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT ON "tenant_certificates" TO app_user;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "tenant_certificates" TO platform_admin;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "tenant_certificates"
  TO app_user
  USING (tenant_id = nullif(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.current_tenant', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "platform_admin_all" ON "tenant_certificates"
  TO platform_admin
  USING (true)
  WITH CHECK (true);
