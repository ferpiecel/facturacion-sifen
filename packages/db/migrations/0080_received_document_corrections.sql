ALTER TABLE "received_document_items" ADD COLUMN "removed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "received_document_items" ADD COLUMN "removed_by" text;--> statement-breakpoint
ALTER TABLE "received_documents" ADD COLUMN "corrected_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "received_documents" ADD COLUMN "corrected_by" text;--> statement-breakpoint
ALTER TABLE "received_document_items" ADD CONSTRAINT "received_document_items_removal_pair" CHECK (("received_document_items"."removed_at" IS NULL) = ("received_document_items"."removed_by" IS NULL));--> statement-breakpoint
ALTER TABLE "received_documents" ADD CONSTRAINT "received_documents_correction_pair" CHECK (("received_documents"."corrected_at" IS NULL) = ("received_documents"."corrected_by" IS NULL));