-- Manual rollback for 0049: restore the check and the guard of 0047 and 0048. Run it only when no event was
-- rejected locally (status rejected with a LOC- code and no batch id), or it fails on the check.
ALTER TABLE "issuer_events" DROP CONSTRAINT IF EXISTS "issuer_events_sent_pair";
ALTER TABLE "issuer_events" ADD CONSTRAINT "issuer_events_sent_pair" CHECK (("status" IN ('pending', 'signed')) = ("batch_d_id" IS NULL) AND ("batch_d_id" IS NULL) = ("send_attempted_at" IS NULL));
-- Then re-apply the CREATE FUNCTION "issuer_events_guard" of 0048 (it has no signed -> rejected transition).
