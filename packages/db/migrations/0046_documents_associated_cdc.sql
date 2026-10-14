ALTER TABLE "documents" ADD COLUMN "associated_cdc" char(44);--> statement-breakpoint
CREATE INDEX "documents_associated_cdc_idx" ON "documents" USING btree ("tenant_id","environment","associated_cdc") WHERE "documents"."associated_cdc" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_associated_cdc_format" CHECK ("documents"."associated_cdc" ~ '^[0-9]{44}$');--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_associated_cdc_not_self" CHECK ("documents"."associated_cdc" <> "documents"."cdc");--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_associated_cdc_not_invoice" CHECK ("documents"."document_type" <> 1 OR "documents"."associated_cdc" IS NULL);--> statement-breakpoint
-- The association is part of the document's identity: set on INSERT, never changed or cleared. A separate
-- guard keeps documents_guard (0034) untouched.
CREATE FUNCTION "documents_associated_cdc_guard"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.associated_cdc IS DISTINCT FROM OLD.associated_cdc THEN
    RAISE EXCEPTION 'documents: associated_cdc is immutable';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "documents_associated_cdc_guard" BEFORE UPDATE ON "documents"
FOR EACH ROW EXECUTE FUNCTION "documents_associated_cdc_guard"();
