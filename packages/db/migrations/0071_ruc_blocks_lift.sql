ALTER TABLE "ruc_blocks" ADD COLUMN "lifted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "ruc_blocks" ADD COLUMN "lifted_by" varchar(255);--> statement-breakpoint
ALTER TABLE "ruc_blocks" ADD COLUMN "lift_reason" varchar(500);--> statement-breakpoint
ALTER TABLE "ruc_blocks" ADD CONSTRAINT "ruc_blocks_lift_complete" CHECK (("ruc_blocks"."lifted_at" IS NULL) = ("ruc_blocks"."lifted_by" IS NULL) AND ("ruc_blocks"."lifted_at" IS NULL) = ("ruc_blocks"."lift_reason" IS NULL));--> statement-breakpoint
-- Lifting a pause is the one update a ruc_blocks row takes (the operator CLI, `ruc:unblock`), so only
-- platform_admin gets UPDATE, and only on the lift columns: app_user stays SELECT/INSERT.
GRANT UPDATE ("lifted_at", "lifted_by", "lift_reason") ON "ruc_blocks" TO platform_admin;
