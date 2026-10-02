-- Manual rollback for 0023: restore the 0021 guard, then drop the idempotency columns.
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
      OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'documents: identity columns are immutable';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
ALTER TABLE "documents" DROP CONSTRAINT IF EXISTS "documents_idempotency_hash_format";
ALTER TABLE "documents" DROP CONSTRAINT IF EXISTS "documents_idempotency_key_format";
ALTER TABLE "documents" DROP CONSTRAINT IF EXISTS "documents_idempotency_pair";
ALTER TABLE "documents" DROP CONSTRAINT IF EXISTS "documents_tenant_idempotency_key_key";
ALTER TABLE "documents" DROP COLUMN IF EXISTS "request_hash";
ALTER TABLE "documents" DROP COLUMN IF EXISTS "idempotency_key";
