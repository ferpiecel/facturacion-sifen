ALTER TABLE "issuer_events" ADD COLUMN "idempotency_key" varchar(255);--> statement-breakpoint
ALTER TABLE "issuer_events" ADD COLUMN "request_hash" char(64);--> statement-breakpoint
CREATE UNIQUE INDEX "issuer_events_idempotency_idx" ON "issuer_events" USING btree ("tenant_id","idempotency_key") WHERE "issuer_events"."idempotency_key" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "issuer_events" ADD CONSTRAINT "issuer_events_idempotency_pair" CHECK (("issuer_events"."idempotency_key" IS NULL) = ("issuer_events"."request_hash" IS NULL));--> statement-breakpoint
-- The key and the hash of the request are part of the event's identity: set on INSERT, never changed. A separate
-- guard keeps issuer_events_guard (0048) untouched.
CREATE FUNCTION "issuer_events_idempotency_guard"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
    OR NEW.request_hash IS DISTINCT FROM OLD.request_hash THEN
    RAISE EXCEPTION 'issuer_events: idempotency_key and request_hash are immutable';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "issuer_events_idempotency_guard" BEFORE UPDATE ON "issuer_events"
FOR EACH ROW EXECUTE FUNCTION "issuer_events_idempotency_guard"();
