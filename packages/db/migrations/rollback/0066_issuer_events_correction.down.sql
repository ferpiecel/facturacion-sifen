-- Manual rollback for 0066: forgets which event each correction corrects (the corrections stay as plain receiver events).
-- Stop the correction endpoint first.
DROP TRIGGER IF EXISTS "issuer_events_correction_guard" ON "issuer_events";
DROP FUNCTION IF EXISTS "issuer_events_correction_guard"();
CREATE OR REPLACE FUNCTION "issuer_events_receiver_guard"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.target_cdc IS DISTINCT FROM OLD.target_cdc
    OR NEW.receiver_data IS DISTINCT FROM OLD.receiver_data THEN
    RAISE EXCEPTION 'issuer_events: target_cdc and receiver_data are immutable';
  END IF;
  RETURN NEW;
END;
$$;
DROP INDEX IF EXISTS "issuer_events_correction_idx";
ALTER TABLE "issuer_events" DROP CONSTRAINT IF EXISTS "issuer_events_correction_subject";
ALTER TABLE "issuer_events" DROP CONSTRAINT IF EXISTS "issuer_events_correction_reason_length";
ALTER TABLE "issuer_events" DROP CONSTRAINT IF EXISTS "issuer_events_correction_pair";
ALTER TABLE "issuer_events" DROP CONSTRAINT IF EXISTS "issuer_events_corrects_event_id_issuer_events_id_fk";
ALTER TABLE "issuer_events" DROP COLUMN IF EXISTS "correction_reason";
ALTER TABLE "issuer_events" DROP COLUMN IF EXISTS "corrects_event_id";
