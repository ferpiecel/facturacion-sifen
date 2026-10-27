-- Manual rollback for 0069. First restore documents_guard by running the CREATE OR REPLACE FUNCTION "documents_guard" of
-- 0034 (the 0069 version reads corrections_count), then drop the history and the counter. Rows already rewritten keep
-- their corrected payload; the previous one is lost with the table.
DROP TABLE IF EXISTS "document_corrections";
ALTER TABLE "documents" DROP CONSTRAINT IF EXISTS "documents_corrections_count_range";
ALTER TABLE "documents" DROP COLUMN IF EXISTS "corrections_count";
