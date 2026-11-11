-- Manual rollback for 0057: drops the idempotency key and hash of issuer events. A retried command can no longer be recognised, so stop the command endpoints first.
DROP TRIGGER IF EXISTS "issuer_events_idempotency_guard" ON "issuer_events";
DROP FUNCTION IF EXISTS "issuer_events_idempotency_guard"();
DROP INDEX IF EXISTS "issuer_events_idempotency_idx";
ALTER TABLE "issuer_events" DROP CONSTRAINT IF EXISTS "issuer_events_idempotency_pair";
ALTER TABLE "issuer_events" DROP COLUMN IF EXISTS "request_hash";
ALTER TABLE "issuer_events" DROP COLUMN IF EXISTS "idempotency_key";
