-- Manual rollback for 0035: drop the send-attempt instant. The recovery then falls back to sent_at
-- (and, for a send that got no answer, never resends: it holds).
ALTER TABLE "lotes" DROP COLUMN IF EXISTS "send_attempted_at";
