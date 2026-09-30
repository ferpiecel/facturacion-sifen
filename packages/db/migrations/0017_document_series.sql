ALTER TABLE "tenant_document_sequences" ADD COLUMN "series" varchar(2) DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "tenant_document_sequences" ADD COLUMN "series_started_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "tenant_document_sequences" DROP CONSTRAINT "tenant_document_sequences_pkey";
--> statement-breakpoint
ALTER TABLE "tenant_document_sequences" ADD CONSTRAINT "tenant_document_sequences_pkey" PRIMARY KEY("tenant_id","environment","timbrado_id","establishment_id","expedition_point_id","document_type","series");--> statement-breakpoint
ALTER TABLE "tenant_document_sequences" ADD CONSTRAINT "tenant_document_sequences_series_format" CHECK ("tenant_document_sequences"."series" = '' OR "tenant_document_sequences"."series" ~ '^[A-Z]{2}$');
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "tenant_document_sequences_guard"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  tenant_env public.tenant_environment;
BEGIN
  SELECT t.environment INTO tenant_env FROM public.tenants t WHERE t.id = NEW.tenant_id;
  IF FOUND AND tenant_env IS DISTINCT FROM NEW.environment THEN
    RAISE EXCEPTION 'tenant_document_sequences: environment must match the tenant''s current environment';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
      OR NEW.environment IS DISTINCT FROM OLD.environment
      OR NEW.timbrado_id IS DISTINCT FROM OLD.timbrado_id
      OR NEW.establishment_id IS DISTINCT FROM OLD.establishment_id
      OR NEW.expedition_point_id IS DISTINCT FROM OLD.expedition_point_id
      OR NEW.document_type IS DISTINCT FROM OLD.document_type
      OR NEW.series IS DISTINCT FROM OLD.series
      OR NEW.series_started_at IS DISTINCT FROM OLD.series_started_at THEN
      RAISE EXCEPTION 'tenant_document_sequences: key columns are immutable';
    END IF;
    IF NEW.last_number IS DISTINCT FROM OLD.last_number + 1 THEN
      RAISE EXCEPTION 'tenant_document_sequences: last_number may only advance by 1';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
