ALTER TABLE "documents" ADD COLUMN "idempotency_key" varchar(255);--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "request_hash" char(64);--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_tenant_idempotency_key_key" UNIQUE("tenant_id","idempotency_key");--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_idempotency_pair" CHECK (("documents"."idempotency_key" IS NULL) = ("documents"."request_hash" IS NULL));--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_idempotency_key_format" CHECK ("documents"."idempotency_key" ~ '^[!-~]{1,255}$');--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_idempotency_hash_format" CHECK ("documents"."request_hash" ~ '^[0-9a-f]{64}$');
--> statement-breakpoint
-- The immutability guard now covers the idempotency columns (trigger from 0021 is kept).
CREATE OR REPLACE FUNCTION "documents_guard"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  tenant_env public.tenant_environment;
BEGIN
  -- A tenant row hidden by RLS is left to the row-level security policy.
  SELECT t.environment INTO tenant_env FROM public.tenants t WHERE t.id = NEW.tenant_id;
  IF FOUND AND tenant_env IS DISTINCT FROM NEW.environment THEN
    RAISE EXCEPTION 'documents: environment must match the tenant''s current environment';
  END IF;
  IF TG_OP = 'UPDATE' THEN
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
      OR NEW.receiver_ruc IS DISTINCT FROM OLD.receiver_ruc
      OR NEW.issued_at IS DISTINCT FROM OLD.issued_at
      OR NEW.total_amount IS DISTINCT FROM OLD.total_amount
      OR NEW.currency IS DISTINCT FROM OLD.currency
      OR NEW.payload IS DISTINCT FROM OLD.payload
      OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
      OR NEW.request_hash IS DISTINCT FROM OLD.request_hash
      OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'documents: identity columns are immutable';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
