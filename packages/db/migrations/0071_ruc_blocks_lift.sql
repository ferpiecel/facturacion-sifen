ALTER TABLE "ruc_blocks" ADD COLUMN "lifted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "ruc_blocks" ADD COLUMN "lifted_by" varchar(255);--> statement-breakpoint
ALTER TABLE "ruc_blocks" ADD COLUMN "lift_reason" varchar(500);--> statement-breakpoint
ALTER TABLE "ruc_blocks" ADD CONSTRAINT "ruc_blocks_lift_complete" CHECK (("ruc_blocks"."lifted_at" IS NULL) = ("ruc_blocks"."lifted_by" IS NULL) AND ("ruc_blocks"."lifted_at" IS NULL) = ("ruc_blocks"."lift_reason" IS NULL));--> statement-breakpoint
-- Lifting a pause is the one update a ruc_blocks row takes (the operator CLI, `ruc:unblock`), so only
-- platform_admin gets UPDATE, and only on the lift columns: app_user stays SELECT/INSERT.
GRANT UPDATE ("lifted_at", "lifted_by", "lift_reason") ON "ruc_blocks" TO platform_admin;
--> statement-breakpoint
-- A lift is write-once: once lifted_at is set, no role (platform_admin included) can null it out or rewrite who lifted
-- it and why. Setting the columns partially is already refused by ruc_blocks_lift_complete.
CREATE FUNCTION "ruc_blocks_lift_write_once"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."lifted_at" IS NOT NULL AND (
    NEW."lifted_at" IS DISTINCT FROM OLD."lifted_at"
    OR NEW."lifted_by" IS DISTINCT FROM OLD."lifted_by"
    OR NEW."lift_reason" IS DISTINCT FROM OLD."lift_reason"
  ) THEN
    RAISE EXCEPTION 'ruc_blocks_lift_write_once: a lifted pause cannot be changed';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "ruc_blocks_lift_write_once" BEFORE UPDATE ON "ruc_blocks"
  FOR EACH ROW EXECUTE FUNCTION "ruc_blocks_lift_write_once"();
