-- Manual rollback for 0046: drop the guard, the constraints, the index and the column. Credit notes
-- created meanwhile lose their association (it stays in their payload).
DROP TRIGGER IF EXISTS "documents_associated_cdc_guard" ON "documents";
DROP FUNCTION IF EXISTS "documents_associated_cdc_guard"();
ALTER TABLE "documents" DROP CONSTRAINT IF EXISTS "documents_associated_cdc_not_invoice";
ALTER TABLE "documents" DROP CONSTRAINT IF EXISTS "documents_associated_cdc_not_self";
ALTER TABLE "documents" DROP CONSTRAINT IF EXISTS "documents_associated_cdc_format";
DROP INDEX IF EXISTS "documents_associated_cdc_idx";
ALTER TABLE "documents" DROP COLUMN IF EXISTS "associated_cdc";
