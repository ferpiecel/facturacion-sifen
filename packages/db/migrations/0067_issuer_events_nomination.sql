ALTER TABLE "issuer_events" ADD COLUMN "nomination" jsonb;--> statement-breakpoint
ALTER TABLE "issuer_events" ADD CONSTRAINT "issuer_events_nomination_subject" CHECK (("issuer_events"."kind" = 'nomination') = ("issuer_events"."nomination" IS NOT NULL));
--> statement-breakpoint
-- The receiver a nomination names is part of the event's identity: set on INSERT, never changed. A separate
-- guard keeps issuer_events_guard (0048) untouched.
CREATE FUNCTION "issuer_events_nomination_guard"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.nomination IS DISTINCT FROM OLD.nomination THEN
    RAISE EXCEPTION 'issuer_events: nomination is immutable';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "issuer_events_nomination_guard" BEFORE UPDATE ON "issuer_events"
FOR EACH ROW EXECUTE FUNCTION "issuer_events_nomination_guard"();
