-- Identity is frozen after insert on the child tables of received_documents: a row can never be
-- re-homed to another document or tenant; the other columns stay editable (document PATCH).
CREATE FUNCTION "received_document_items_guard"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.received_document_id IS DISTINCT FROM OLD.received_document_id THEN
    RAISE EXCEPTION 'received_document_items: identity columns are immutable';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "received_document_items_guard" BEFORE UPDATE ON "received_document_items"
FOR EACH ROW EXECUTE FUNCTION "received_document_items_guard"();
--> statement-breakpoint
CREATE FUNCTION "received_document_field_confidences_guard"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.received_document_id IS DISTINCT FROM OLD.received_document_id THEN
    RAISE EXCEPTION 'received_document_field_confidences: identity columns are immutable';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "received_document_field_confidences_guard" BEFORE UPDATE ON "received_document_field_confidences"
FOR EACH ROW EXECUTE FUNCTION "received_document_field_confidences_guard"();
