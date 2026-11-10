-- Manual rollback for 0053 (run 0054's rollback first). Dropping the columns drops their CHECKs;
-- soft-removed items stay in the table and become active again, so review them before rolling back.
ALTER TABLE "received_documents" DROP CONSTRAINT IF EXISTS "received_documents_correction_pair";
--> statement-breakpoint
ALTER TABLE "received_document_items" DROP CONSTRAINT IF EXISTS "received_document_items_removal_pair";
--> statement-breakpoint
ALTER TABLE "received_documents" DROP COLUMN IF EXISTS "corrected_by";
--> statement-breakpoint
ALTER TABLE "received_documents" DROP COLUMN IF EXISTS "corrected_at";
--> statement-breakpoint
ALTER TABLE "received_document_items" DROP COLUMN IF EXISTS "removed_by";
--> statement-breakpoint
ALTER TABLE "received_document_items" DROP COLUMN IF EXISTS "removed_at";
