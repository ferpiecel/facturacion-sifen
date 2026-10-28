-- Manual rollback for 0065: removes the receiver events (they were sent to SIFEN, so keep a copy of the table first).
-- Stop the receiver event endpoint before running it.
DROP TRIGGER IF EXISTS "issuer_events_receiver_guard" ON "issuer_events";
DROP FUNCTION IF EXISTS "issuer_events_receiver_guard"();
DROP INDEX IF EXISTS "issuer_events_receiver_open_idx";
ALTER TABLE "issuer_events" DROP CONSTRAINT IF EXISTS "issuer_events_kind_valid";
ALTER TABLE "issuer_events" DROP CONSTRAINT IF EXISTS "issuer_events_reason_length";
ALTER TABLE "issuer_events" DROP CONSTRAINT IF EXISTS "issuer_events_reason_required";
ALTER TABLE "issuer_events" DROP CONSTRAINT IF EXISTS "issuer_events_subject";
ALTER TABLE "issuer_events" DROP CONSTRAINT IF EXISTS "issuer_events_target_cdc_format";
DELETE FROM "issuer_events" WHERE "target_cdc" IS NOT NULL;
ALTER TABLE "issuer_events" DROP COLUMN IF EXISTS "receiver_data";
ALTER TABLE "issuer_events" DROP COLUMN IF EXISTS "target_cdc";
ALTER TABLE "issuer_events" ALTER COLUMN "reason" SET NOT NULL;
ALTER TABLE "issuer_events" ADD CONSTRAINT "issuer_events_kind_valid" CHECK ("kind" IN ('cancellation', 'voiding', 'nomination'));
ALTER TABLE "issuer_events" ADD CONSTRAINT "issuer_events_reason_length" CHECK (char_length("reason") BETWEEN 5 AND 500);
ALTER TABLE "issuer_events" ADD CONSTRAINT "issuer_events_subject" CHECK (("kind" = 'voiding') = ("void_range" IS NOT NULL) AND ("kind" = 'voiding') = ("document_id" IS NULL));
