-- On INSERT: an event starts pending, belongs to the tenant's current environment, and so does the document it targets
-- (the composite foreign key checks the tenant, not the environment).
CREATE FUNCTION "issuer_events_insert_guard"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  tenant_env public.tenant_environment;
  document_env public.tenant_environment;
BEGIN
  -- The state machine runs on UPDATE: an event may only be created at its start, never already signed, sent or answered.
  IF NEW.status IS DISTINCT FROM 'pending' THEN
    RAISE EXCEPTION 'issuer_events: an event starts pending';
  END IF;
  SELECT t.environment INTO tenant_env FROM public.tenants t WHERE t.id = NEW.tenant_id;
  IF FOUND AND tenant_env IS DISTINCT FROM NEW.environment THEN
    RAISE EXCEPTION 'issuer_events: environment must match the tenant''s current environment';
  END IF;
  IF NEW.document_id IS NOT NULL THEN
    SELECT d.environment INTO document_env
    FROM public.documents d WHERE d.tenant_id = NEW.tenant_id AND d.id = NEW.document_id;
    IF FOUND AND document_env IS DISTINCT FROM NEW.environment THEN
      RAISE EXCEPTION 'issuer_events: the document belongs to another environment';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "issuer_events_insert_guard" BEFORE INSERT ON "issuer_events"
FOR EACH ROW EXECUTE FUNCTION "issuer_events_insert_guard"();
--> statement-breakpoint
-- On UPDATE: what the event is stays frozen; the signed XML and its instant, the send stamps are write-once;
-- statuses only move pending -> signed -> sending -> approved | rejected | unknown, and an unanswered
-- send (unknown) may still be answered. An answered event is final. updated_at is maintained here.
CREATE FUNCTION "issuer_events_guard"() RETURNS trigger
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
--> statement-breakpoint
CREATE TRIGGER "issuer_events_guard" BEFORE UPDATE ON "issuer_events"
FOR EACH ROW EXECUTE FUNCTION "issuer_events_guard"();
