-- Soft removal guard for received_document_items (replaces the identity-only guard of 0079).
-- An item is removed by setting removed_at and removed_by once, in an update that changes nothing
-- else (updated_at aside). A removed item is frozen: it can neither be restored nor edited, so the
-- last state before the removal stays on record (fiscal retention; app_user has no DELETE).
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
  IF OLD.removed_at IS NOT NULL THEN
    IF (to_jsonb(NEW) - 'updated_at') IS DISTINCT FROM (to_jsonb(OLD) - 'updated_at') THEN
      RAISE EXCEPTION 'received_document_items: a removed item is frozen';
    END IF;
  ELSIF NEW.removed_at IS NOT NULL THEN
    IF (to_jsonb(NEW) - 'updated_at' - 'removed_at' - 'removed_by')
      IS DISTINCT FROM (to_jsonb(OLD) - 'updated_at' - 'removed_at' - 'removed_by') THEN
      RAISE EXCEPTION 'received_document_items: removal cannot change other columns';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
