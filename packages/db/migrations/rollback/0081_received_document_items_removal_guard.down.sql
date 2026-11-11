-- Manual rollback for 0081: restores the identity-only guard of 0079. Run before 0080's rollback.
CREATE OR REPLACE FUNCTION "received_document_items_guard"() RETURNS trigger
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
