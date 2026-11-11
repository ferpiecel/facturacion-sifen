-- Manual rollback for 0070: drops the watermark, its triggers and the lote sequence. Ordering falls back to created_at.
DROP TRIGGER "documents_resent_seq" ON "documents";--> statement-breakpoint
DROP FUNCTION "documents_resent_seq"();--> statement-breakpoint
ALTER TABLE "lotes" DROP CONSTRAINT "lotes_seq_key";--> statement-breakpoint
ALTER TABLE "lotes" DROP COLUMN "seq";--> statement-breakpoint
ALTER TABLE "documents" DROP COLUMN "resent_after_seq";
