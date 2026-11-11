ALTER TABLE "issuer_events" ADD COLUMN "corrects_event_id" uuid;--> statement-breakpoint
ALTER TABLE "issuer_events" ADD COLUMN "correction_reason" text;--> statement-breakpoint
ALTER TABLE "issuer_events" ADD CONSTRAINT "issuer_events_corrects_event_id_issuer_events_id_fk" FOREIGN KEY ("corrects_event_id") REFERENCES "public"."issuer_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "issuer_events_correction_idx" ON "issuer_events" USING btree ("corrects_event_id") WHERE "issuer_events"."corrects_event_id" IS NOT NULL AND "issuer_events"."status" <> 'rejected';--> statement-breakpoint
ALTER TABLE "issuer_events" ADD CONSTRAINT "issuer_events_correction_pair" CHECK (("issuer_events"."corrects_event_id" IS NULL) = ("issuer_events"."correction_reason" IS NULL));--> statement-breakpoint
ALTER TABLE "issuer_events" ADD CONSTRAINT "issuer_events_correction_reason_length" CHECK ("issuer_events"."correction_reason" IS NULL OR char_length("issuer_events"."correction_reason") BETWEEN 5 AND 500);--> statement-breakpoint
ALTER TABLE "issuer_events" ADD CONSTRAINT "issuer_events_correction_subject" CHECK ("issuer_events"."corrects_event_id" IS NULL OR ("issuer_events"."target_cdc" IS NOT NULL AND "issuer_events"."kind" <> 'receipt_notice' AND "issuer_events"."corrects_event_id" <> "issuer_events"."id"));--> statement-breakpoint
-- A correction points at an APPROVED receiver event of the same tenant and CDC that is not itself a correction.
-- The foreign key alone would accept any row (its check bypasses RLS), so this trigger checks the rest on INSERT.
CREATE FUNCTION "issuer_events_correction_guard"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  original public.issuer_events%ROWTYPE;
BEGIN
  IF NEW.corrects_event_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT * INTO original FROM public.issuer_events e WHERE e.id = NEW.corrects_event_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'issuer_events: the corrected event does not exist';
  END IF;
  IF original.tenant_id IS DISTINCT FROM NEW.tenant_id THEN
    RAISE EXCEPTION 'issuer_events: a correction must belong to the same tenant as the corrected event';
  END IF;
  IF original.kind NOT IN ('conformity', 'disconformity', 'unawareness') THEN
    RAISE EXCEPTION 'issuer_events: only a receiver event can be corrected';
  END IF;
  IF original.target_cdc IS DISTINCT FROM NEW.target_cdc THEN
    RAISE EXCEPTION 'issuer_events: a correction must target the same CDC as the corrected event';
  END IF;
  IF original.status <> 'approved' THEN
    RAISE EXCEPTION 'issuer_events: only an approved event can be corrected';
  END IF;
  IF original.corrects_event_id IS NOT NULL THEN
    RAISE EXCEPTION 'issuer_events: a correction cannot be corrected';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "issuer_events_correction_guard" BEFORE INSERT ON "issuer_events"
FOR EACH ROW EXECUTE FUNCTION "issuer_events_correction_guard"();
--> statement-breakpoint
-- The guard of 0065 with the correction columns, which are part of the event's identity too.
CREATE OR REPLACE FUNCTION "issuer_events_receiver_guard"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.target_cdc IS DISTINCT FROM OLD.target_cdc
    OR NEW.receiver_data IS DISTINCT FROM OLD.receiver_data
    OR NEW.corrects_event_id IS DISTINCT FROM OLD.corrects_event_id
    OR NEW.correction_reason IS DISTINCT FROM OLD.correction_reason THEN
    RAISE EXCEPTION 'issuer_events: target_cdc, receiver_data and the correction columns are immutable';
  END IF;
  RETURN NEW;
END;
$$;
