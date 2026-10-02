ALTER TABLE "lotes" DROP CONSTRAINT "lotes_status_valid";--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "sifen_messages" jsonb;--> statement-breakpoint
ALTER TABLE "lotes" ADD COLUMN "last_polled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "lotes" ADD COLUMN "last_poll_message" text;--> statement-breakpoint
ALTER TABLE "lotes" ADD CONSTRAINT "lotes_status_valid" CHECK ("lotes"."status" IN ('pending', 'sending', 'sent', 'rejected', 'unknown', 'processed', 'recovery'));
--> statement-breakpoint
-- Guards: statuses only move forward; documents_guard from 0023 gains the transition rule.
CREATE FUNCTION "documents_status_rank"(status text) RETURNS integer
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT CASE status
    WHEN 'accepted' THEN 0
    WHEN 'signed' THEN 1
    WHEN 'queued' THEN 2
    WHEN 'submitted' THEN 3
    WHEN 'approved' THEN 4
    WHEN 'approved_with_observations' THEN 4
    WHEN 'rejected' THEN 4
    WHEN 'corrected' THEN 5
    WHEN 'number_voided' THEN 5
    WHEN 'cancelled' THEN 5
    ELSE NULL -- unknown status: the guard refuses it
  END
$$;
--> statement-breakpoint
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
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "lotes_guard"() RETURNS trigger
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
    IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
      (OLD.status = 'pending' AND NEW.status = 'sending')
      OR (OLD.status = 'sending' AND NEW.status IN ('sent', 'rejected', 'unknown'))
      -- HU-E6-04 recovery of a lote whose answer was lost.
      OR (OLD.status = 'unknown' AND NEW.status IN ('sent', 'rejected'))
      -- HU-E6-03: the result query settled the lote or handed it to recovery; both are terminal here.
      OR (OLD.status = 'sent' AND NEW.status IN ('processed', 'recovery'))
    ) THEN
      RAISE EXCEPTION 'lotes: invalid status transition % -> %', OLD.status, NEW.status;
    END IF;
    IF (OLD.sent_at IS NOT NULL AND NEW.sent_at IS DISTINCT FROM OLD.sent_at)
      OR (OLD.sifen_protocol IS NOT NULL AND NEW.sifen_protocol IS DISTINCT FROM OLD.sifen_protocol) THEN
      RAISE EXCEPTION 'lotes: sent_at and sifen_protocol are write-once';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
