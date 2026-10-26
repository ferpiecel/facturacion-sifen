-- Manual rollback for 0056: drops the guard and the approval instant. The cancellation deadline can no longer be checked until the column is added again and refreshed from SIFEN.
DROP TRIGGER IF EXISTS "documents_approved_at_guard" ON "documents";
DROP FUNCTION IF EXISTS "documents_approved_at_guard"();
ALTER TABLE "documents" DROP COLUMN IF EXISTS "approved_at";
