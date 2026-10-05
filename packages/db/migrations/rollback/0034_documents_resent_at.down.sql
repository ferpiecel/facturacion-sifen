-- Manual rollback for 0034: restore the 0025 documents guard, then drop the column. Documents the
-- recovery queued again keep their status and attempts.
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
    -- The signed XML and its instant are set once (HU-E6-02).
    IF (OLD.signed_xml IS NOT NULL AND NEW.signed_xml IS DISTINCT FROM OLD.signed_xml)
      OR (OLD.signed_at IS NOT NULL AND NEW.signed_at IS DISTINCT FROM OLD.signed_at) THEN
      RAISE EXCEPTION 'documents: signed_xml and signed_at are write-once';
    END IF;
    -- ...and only while the document is (or becomes) signed (rank below submitted).
    IF (OLD.signed_xml IS NULL AND NEW.signed_xml IS NOT NULL)
      OR (OLD.signed_at IS NULL AND NEW.signed_at IS NOT NULL) THEN
      IF NEW.status IS DISTINCT FROM 'signed'
        OR public.documents_status_rank(OLD.status) >= public.documents_status_rank('submitted') THEN
        RAISE EXCEPTION 'documents: signed_xml and signed_at can only be set while signing';
      END IF;
    END IF;
    -- Statuses only move forward; a SIFEN outcome is entered once, from submitted (HU-E6-03).
    IF NEW.status IS DISTINCT FROM OLD.status THEN
      IF public.documents_status_rank(NEW.status) IS NULL
        OR public.documents_status_rank(OLD.status) IS NULL THEN
        RAISE EXCEPTION 'documents: unranked status % -> %', OLD.status, NEW.status;
      END IF;
      IF NOT (
        public.documents_status_rank(NEW.status) > public.documents_status_rank(OLD.status)
        AND (public.documents_status_rank(NEW.status) <> 4 OR OLD.status = 'submitted')
      ) THEN
        RAISE EXCEPTION 'documents: invalid status transition % -> %', OLD.status, NEW.status;
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
ALTER TABLE "documents" DROP COLUMN IF EXISTS "resent_at";
