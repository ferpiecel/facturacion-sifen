ALTER TABLE "documents" ADD COLUMN "transmission_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "next_transmission_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "transmission_hold" varchar(64);--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_transmission_attempts_range" CHECK ("documents"."transmission_attempts" >= 0);--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_transmission_hold_format" CHECK ("documents"."transmission_hold" ~ '^[A-Za-z0-9:_-]{1,64}$');