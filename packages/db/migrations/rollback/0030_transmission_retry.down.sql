-- Manual rollback for 0030: drop the retry constraints, then the columns (documents_guard is unchanged).
ALTER TABLE "documents" DROP CONSTRAINT IF EXISTS "documents_transmission_hold_format";
ALTER TABLE "documents" DROP CONSTRAINT IF EXISTS "documents_transmission_attempts_range";
ALTER TABLE "documents" DROP COLUMN IF EXISTS "transmission_hold";
ALTER TABLE "documents" DROP COLUMN IF EXISTS "next_transmission_at";
ALTER TABLE "documents" DROP COLUMN IF EXISTS "transmission_attempts";
