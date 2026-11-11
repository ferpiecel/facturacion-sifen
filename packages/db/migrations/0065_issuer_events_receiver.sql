ALTER TABLE "issuer_events" DROP CONSTRAINT "issuer_events_kind_valid";--> statement-breakpoint
ALTER TABLE "issuer_events" DROP CONSTRAINT "issuer_events_reason_length";--> statement-breakpoint
ALTER TABLE "issuer_events" DROP CONSTRAINT "issuer_events_subject";--> statement-breakpoint
ALTER TABLE "issuer_events" ALTER COLUMN "reason" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "issuer_events" ADD COLUMN "target_cdc" char(44);--> statement-breakpoint
ALTER TABLE "issuer_events" ADD COLUMN "receiver_data" jsonb;--> statement-breakpoint
CREATE UNIQUE INDEX "issuer_events_receiver_open_idx" ON "issuer_events" USING btree ("tenant_id","environment","target_cdc","kind",coalesce("receiver_data"->>'conformityType', '')) WHERE "issuer_events"."target_cdc" IS NOT NULL AND "issuer_events"."status" <> 'rejected';--> statement-breakpoint
ALTER TABLE "issuer_events" ADD CONSTRAINT "issuer_events_kind_valid" CHECK ("issuer_events"."kind" IN ('cancellation', 'voiding', 'nomination', 'conformity', 'disconformity', 'unawareness', 'receipt_notice'));--> statement-breakpoint
ALTER TABLE "issuer_events" ADD CONSTRAINT "issuer_events_reason_length" CHECK ("issuer_events"."reason" IS NULL OR char_length("issuer_events"."reason") BETWEEN 5 AND 500);--> statement-breakpoint
ALTER TABLE "issuer_events" ADD CONSTRAINT "issuer_events_reason_required" CHECK (("issuer_events"."reason" IS NULL) = ("issuer_events"."kind" IN ('conformity', 'receipt_notice')));--> statement-breakpoint
ALTER TABLE "issuer_events" ADD CONSTRAINT "issuer_events_subject" CHECK (("issuer_events"."kind" = 'voiding') = ("issuer_events"."void_range" IS NOT NULL) AND ("issuer_events"."kind" IN ('cancellation', 'nomination')) = ("issuer_events"."document_id" IS NOT NULL) AND ("issuer_events"."kind" IN ('conformity', 'disconformity', 'unawareness', 'receipt_notice')) = ("issuer_events"."target_cdc" IS NOT NULL) AND ("issuer_events"."target_cdc" IS NOT NULL) = ("issuer_events"."receiver_data" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "issuer_events" ADD CONSTRAINT "issuer_events_target_cdc_format" CHECK ("issuer_events"."target_cdc" IS NULL OR "issuer_events"."target_cdc" ~ '^[0-9]{44}$');--> statement-breakpoint
-- The CDC and the data of a receiver event are part of its identity: set on INSERT, never changed. A separate
-- guard keeps issuer_events_guard (0048, 0049) untouched, as 0057 did for the idempotency key.
CREATE FUNCTION "issuer_events_receiver_guard"() RETURNS trigger
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
--> statement-breakpoint
CREATE TRIGGER "issuer_events_receiver_guard" BEFORE UPDATE ON "issuer_events"
FOR EACH ROW EXECUTE FUNCTION "issuer_events_receiver_guard"();
