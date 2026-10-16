ALTER TABLE "issuer_events" DROP CONSTRAINT "issuer_events_sent_pair";--> statement-breakpoint
ALTER TABLE "issuer_events" DROP CONSTRAINT "issuer_events_answered_pair";--> statement-breakpoint
ALTER TABLE "issuer_events" ADD CONSTRAINT "issuer_events_sent_pair" CHECK ((("issuer_events"."status" IN ('pending', 'signed')) = ("issuer_events"."batch_d_id" IS NULL) OR ("issuer_events"."status" = 'rejected' AND "issuer_events"."batch_d_id" IS NULL AND "issuer_events"."response_code" LIKE 'LOC-%')) AND ("issuer_events"."batch_d_id" IS NULL) = ("issuer_events"."send_attempted_at" IS NULL));--> statement-breakpoint
ALTER TABLE "issuer_events" ADD CONSTRAINT "issuer_events_answered_pair" CHECK (("issuer_events"."response_code" IS NULL) = ("issuer_events"."responded_at" IS NULL) AND ("issuer_events"."status" = 'unknown' OR ("issuer_events"."status" IN ('approved', 'rejected')) = ("issuer_events"."response_code" IS NOT NULL)));
--> statement-breakpoint
-- The guard of 0048 with one more transition: signed -> rejected, only with a local code.
CREATE OR REPLACE FUNCTION "issuer_events_guard"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.environment IS DISTINCT FROM OLD.environment
    OR NEW.kind IS DISTINCT FROM OLD.kind
    OR NEW.event_id IS DISTINCT FROM OLD.event_id
    OR NEW.document_id IS DISTINCT FROM OLD.document_id
    OR NEW.void_range IS DISTINCT FROM OLD.void_range
    OR NEW.reason IS DISTINCT FROM OLD.reason
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'issuer_events: identity columns are immutable';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
    (OLD.status = 'pending' AND NEW.status = 'signed')
    OR (OLD.status = 'signed' AND NEW.status = 'sending')
    OR (OLD.status = 'sending' AND NEW.status IN ('approved', 'rejected', 'unknown'))
    OR (OLD.status = 'unknown' AND NEW.status IN ('approved', 'rejected'))
    -- An event that failed the XSD is rejected here, never sent (a LOC- code, ADR-0020).
    OR (OLD.status = 'signed' AND NEW.status = 'rejected' AND NEW.response_code LIKE 'LOC-%')
  ) THEN
    RAISE EXCEPTION 'issuer_events: invalid status transition % -> %', OLD.status, NEW.status;
  END IF;
  IF (OLD.signed_xml IS NOT NULL AND NEW.signed_xml IS DISTINCT FROM OLD.signed_xml)
    OR (OLD.signed_at IS NOT NULL AND NEW.signed_at IS DISTINCT FROM OLD.signed_at) THEN
    RAISE EXCEPTION 'issuer_events: signed_xml and signed_at are write-once';
  END IF;
  IF (OLD.batch_d_id IS NOT NULL AND NEW.batch_d_id IS DISTINCT FROM OLD.batch_d_id)
    OR (OLD.send_attempted_at IS NOT NULL AND NEW.send_attempted_at IS DISTINCT FROM OLD.send_attempted_at) THEN
    RAISE EXCEPTION 'issuer_events: batch_d_id and send_attempted_at are write-once';
  END IF;
  IF OLD.status IN ('approved', 'rejected') AND (
    NEW.response_code IS DISTINCT FROM OLD.response_code
    OR NEW.response_message IS DISTINCT FROM OLD.response_message
    OR NEW.sifen_protocol IS DISTINCT FROM OLD.sifen_protocol
    OR NEW.responded_at IS DISTINCT FROM OLD.responded_at
  ) THEN
    RAISE EXCEPTION 'issuer_events: an answered event is final';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
