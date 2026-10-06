-- CHECK constraints cannot hold subqueries, hence the function: at most 10 recovery hashes, each a
-- 64-character lower-case hex SHA-256.
CREATE FUNCTION "user_mfa_hashes_valid"(hashes text[]) RETURNS boolean
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$ SELECT cardinality(hashes) <= 10 AND NOT EXISTS (SELECT 1 FROM unnest(hashes) AS h WHERE h IS NULL OR h !~ '^[0-9a-f]{64}$') $$;
--> statement-breakpoint
CREATE TABLE "user_mfa" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"sealed" jsonb NOT NULL,
	"confirmed_at" timestamp with time zone,
	"last_used_step" bigint,
	"recovery_hashes" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_mfa_recovery_hashes_valid" CHECK (user_mfa_hashes_valid("user_mfa"."recovery_hashes")),
	CONSTRAINT "user_mfa_step_needs_confirmation" CHECK ("user_mfa"."last_used_step" IS NULL OR "user_mfa"."confirmed_at" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "user_mfa" ADD CONSTRAINT "user_mfa_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
-- Identity and the sealed secret are fixed once MFA is confirmed (a reset deletes the row and enrols
-- anew); confirmed_at is write-once; the replay step only moves forward; updated_at is maintained here.
CREATE FUNCTION "user_mfa_guard"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'user_mfa: identity columns are immutable';
  END IF;
  IF OLD.confirmed_at IS NOT NULL THEN
    IF NEW.confirmed_at IS DISTINCT FROM OLD.confirmed_at THEN
      RAISE EXCEPTION 'user_mfa: confirmed_at is write-once';
    END IF;
    IF NEW.sealed IS DISTINCT FROM OLD.sealed THEN
      RAISE EXCEPTION 'user_mfa: the sealed secret is immutable once confirmed';
    END IF;
    -- A consumed recovery code can never come back: the set only shrinks (a reset deletes the row).
    IF NOT (NEW.recovery_hashes <@ OLD.recovery_hashes)
      OR cardinality(NEW.recovery_hashes) > cardinality(OLD.recovery_hashes) THEN
      RAISE EXCEPTION 'user_mfa: recovery_hashes can only shrink once confirmed';
    END IF;
  END IF;
  IF OLD.last_used_step IS NOT NULL
    AND (NEW.last_used_step IS NULL OR NEW.last_used_step < OLD.last_used_step) THEN
    RAISE EXCEPTION 'user_mfa: last_used_step cannot decrease';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "user_mfa_guard" BEFORE UPDATE ON "user_mfa"
FOR EACH ROW EXECUTE FUNCTION "user_mfa_guard"();
--> statement-breakpoint
-- RLS + grants: global like users, so FORCE RLS and no app_user grant; the operator role manages it and
-- the login resolver of a later slice gets its own narrow role.
ALTER TABLE "user_mfa" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "user_mfa" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "user_mfa" TO platform_admin;
--> statement-breakpoint
CREATE POLICY "platform_admin_all" ON "user_mfa"
  TO platform_admin
  USING (true)
  WITH CHECK (true);
