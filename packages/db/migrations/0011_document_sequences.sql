CREATE TABLE "tenant_document_sequences" (
	"tenant_id" uuid NOT NULL,
	"environment" "tenant_environment" NOT NULL,
	"timbrado_id" uuid NOT NULL,
	"establishment_id" uuid NOT NULL,
	"expedition_point_id" uuid NOT NULL,
	"document_type" smallint NOT NULL,
	"last_number" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "tenant_document_sequences_pkey" PRIMARY KEY("tenant_id","environment","timbrado_id","establishment_id","expedition_point_id","document_type"),
	CONSTRAINT "tenant_document_sequences_document_type_range" CHECK ("tenant_document_sequences"."document_type" BETWEEN 1 AND 8),
	CONSTRAINT "tenant_document_sequences_last_number_range" CHECK ("tenant_document_sequences"."last_number" BETWEEN 0 AND 9999999)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_expedition_points_tenant_establishment_id_idx" ON "tenant_expedition_points" USING btree ("tenant_id","establishment_id","id");
--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_timbrados_tenant_id_id_idx" ON "tenant_timbrados" USING btree ("tenant_id","id");
--> statement-breakpoint
CREATE UNIQUE INDEX "tenants_id_environment_idx" ON "tenants" USING btree ("id","environment");
--> statement-breakpoint
ALTER TABLE "tenant_document_sequences" ADD CONSTRAINT "tenant_document_sequences_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "tenant_document_sequences" ADD CONSTRAINT "tenant_document_sequences_tenant_timbrado_fk" FOREIGN KEY ("tenant_id","timbrado_id") REFERENCES "public"."tenant_timbrados"("tenant_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "tenant_document_sequences" ADD CONSTRAINT "tenant_document_sequences_tenant_point_fk" FOREIGN KEY ("tenant_id","establishment_id","expedition_point_id") REFERENCES "public"."tenant_expedition_points"("tenant_id","establishment_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "tenant_document_sequences" ADD CONSTRAINT "tenant_document_sequences_tenant_environment_fk" FOREIGN KEY ("tenant_id","environment") REFERENCES "public"."tenants"("id","environment") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE FUNCTION "tenant_document_sequences_guard"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.environment IS DISTINCT FROM OLD.environment
    OR NEW.timbrado_id IS DISTINCT FROM OLD.timbrado_id
    OR NEW.establishment_id IS DISTINCT FROM OLD.establishment_id
    OR NEW.expedition_point_id IS DISTINCT FROM OLD.expedition_point_id
    OR NEW.document_type IS DISTINCT FROM OLD.document_type THEN
    RAISE EXCEPTION 'tenant_document_sequences: key columns are immutable';
  END IF;
  IF NEW.last_number IS DISTINCT FROM OLD.last_number + 1 THEN
    RAISE EXCEPTION 'tenant_document_sequences: last_number may only advance by 1';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "tenant_document_sequences_guard" BEFORE UPDATE ON "tenant_document_sequences"
FOR EACH ROW EXECUTE FUNCTION "tenant_document_sequences_guard"();
