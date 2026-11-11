-- Manual rollback for 0067: drops the nominated receiver of issuer events. Nominations already requested lose the data they are signed from, so stop the nominate endpoint and let pending nominations settle first.
DROP TRIGGER IF EXISTS "issuer_events_nomination_guard" ON "issuer_events";
DROP FUNCTION IF EXISTS "issuer_events_nomination_guard"();
ALTER TABLE "issuer_events" DROP CONSTRAINT IF EXISTS "issuer_events_nomination_subject";
ALTER TABLE "issuer_events" DROP COLUMN IF EXISTS "nomination";
