ALTER TABLE "documents" ADD COLUMN "resent_at" timestamp with time zone;--> statement-breakpoint
-- documents_guard from 0025 plus the write-once resend stamp and the one audited way back.
CREATE OR REPLACE FUNCTION "documents_guard"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  tenant_env public.tenant_environment;
  door_ok boolean;
  stamping boolean;
BEGIN
  -- A tenant row hidden by RLS is left to the row-level security policy.
  SELECT t.environment INTO tenant_env FROM public.tenants t WHERE t.id = NEW.tenant_id;
  IF FOUND AND tenant_env IS DISTINCT FROM NEW.environment THEN
    RAISE EXCEPTION 'documents: environment must match the tenant''s current environment';
  END IF;
  -- resent_at is only ever set by the recovery queueing a document again (HU-E6-04), never on INSERT.
  IF TG_OP = 'INSERT' AND NEW.resent_at IS NOT NULL THEN
    RAISE EXCEPTION 'documents: resent_at can only be set when the recovery queues the document again';
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
    -- The resend stamp is set once (HU-E6-04).
    IF OLD.resent_at IS NOT NULL AND NEW.resent_at IS DISTINCT FROM OLD.resent_at THEN
      RAISE EXCEPTION 'documents: resent_at is write-once';
    END IF;
    -- The one way to set it, and the one way back from submitted: the recovery queues the document
    -- again. Stamped now, the attempt counted (+1), nothing holds it and one of its lotes has given up
    -- on it (recovery, unknown or processed). A submitted or an already queued document (the one of an
    -- unanswered send) may be stamped, always ending queued.
    stamping := OLD.resent_at IS NULL AND NEW.resent_at IS NOT NULL;
    IF stamping THEN
      IF NOT (OLD.status IN ('submitted', 'queued') AND NEW.status = 'queued') THEN
        RAISE EXCEPTION 'documents: resent_at can only be set when the recovery queues the document again';
      END IF;
      door_ok := NEW.transmission_attempts = OLD.transmission_attempts + 1
        AND NEW.transmission_hold IS NULL
        AND EXISTS (
          SELECT 1
          FROM public.lote_documents ld
          JOIN public.lotes l ON l.tenant_id = ld.tenant_id AND l.id = ld.lote_id
          WHERE ld.tenant_id = NEW.tenant_id
            AND ld.document_id = NEW.id
            AND l.status IN ('recovery', 'unknown', 'processed')
        );
      IF NOT door_ok THEN
        IF OLD.status = 'submitted' THEN
          RAISE EXCEPTION 'documents: invalid status transition % -> %', OLD.status, NEW.status;
        END IF;
        RAISE EXCEPTION 'documents: resent_at can only be set when the recovery queues the document again';
      END IF;
    END IF;
    -- Statuses only move forward; a SIFEN outcome is entered once, from submitted (HU-E6-03).
    IF NEW.status IS DISTINCT FROM OLD.status THEN
      IF public.documents_status_rank(NEW.status) IS NULL
        OR public.documents_status_rank(OLD.status) IS NULL THEN
        RAISE EXCEPTION 'documents: unranked status % -> %', OLD.status, NEW.status;
      END IF;
      IF OLD.status = 'submitted' AND NEW.status = 'queued' THEN
        IF NOT stamping THEN
          RAISE EXCEPTION 'documents: invalid status transition % -> %', OLD.status, NEW.status;
        END IF;
      ELSIF NOT (
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
