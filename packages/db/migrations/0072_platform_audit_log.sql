CREATE TABLE "platform_audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor" varchar(255) NOT NULL,
	"purpose" varchar(100) NOT NULL,
	"scope" jsonb NOT NULL,
	"row_count" integer,
	"seq" bigint DEFAULT 0 NOT NULL,
	"prev_hash" text DEFAULT '' NOT NULL,
	"hash" text DEFAULT '' NOT NULL,
	CONSTRAINT "platform_audit_log_seq_unique" UNIQUE("seq"),
	CONSTRAINT "platform_audit_log_actor_not_blank" CHECK (btrim("platform_audit_log"."actor") <> ''),
	CONSTRAINT "platform_audit_log_purpose_not_blank" CHECK (btrim("platform_audit_log"."purpose") <> ''),
	CONSTRAINT "platform_audit_log_scope_array" CHECK (jsonb_typeof("platform_audit_log"."scope") = 'array')
);
--> statement-breakpoint
CREATE INDEX "platform_audit_log_actor_purpose_idx" ON "platform_audit_log" USING btree ("actor","purpose","occurred_at");
--> statement-breakpoint
-- Audit of every use of platform_admin (ADR-0023). Cross-tenant, so no tenant_id and a single SHA-256
-- chain (same recipe as audit_log, 0018; genesis prev_hash = 64 zeros). Only platform_admin can read and
-- append; app_user has no grant. Nobody can UPDATE, DELETE or TRUNCATE (no maintenance role): the table
-- owner can still disable triggers, so keep that role out of the app's reach.
ALTER TABLE "platform_audit_log" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "platform_audit_log" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT ON "platform_audit_log" TO platform_admin;
--> statement-breakpoint
CREATE POLICY "platform_admin_all" ON "platform_audit_log"
  TO platform_admin
  USING (true)
  WITH CHECK (true);
--> statement-breakpoint
CREATE FUNCTION platform_audit_log_compute_hash(
  p_id uuid, p_seq bigint, p_occurred_at timestamptz, p_actor text, p_purpose text,
  p_scope jsonb, p_row_count integer, p_prev_hash text
) RETURNS text
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog, pg_temp AS $$
  SELECT encode(sha256(convert_to(jsonb_build_array(
    p_id, p_seq,
    to_char(p_occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US'),
    p_actor, p_purpose, p_scope, p_row_count, p_prev_hash)::text, 'UTF8')), 'hex')
$$;
--> statement-breakpoint
CREATE FUNCTION platform_audit_log_before_insert() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  last_seq bigint;
  last_hash text;
BEGIN
  NEW.occurred_at := now();
  PERFORM pg_advisory_xact_lock(hashtextextended('platform_audit_log', 0));
  SELECT a.seq, a.hash INTO last_seq, last_hash
    FROM public.platform_audit_log a ORDER BY a.seq DESC LIMIT 1;
  NEW.seq := coalesce(last_seq, 0) + 1;
  NEW.prev_hash := coalesce(last_hash, repeat('0', 64));
  NEW.hash := public.platform_audit_log_compute_hash(NEW.id, NEW.seq, NEW.occurred_at, NEW.actor,
    NEW.purpose, NEW.scope, NEW.row_count, NEW.prev_hash);
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER platform_audit_log_chain
  BEFORE INSERT ON "platform_audit_log"
  FOR EACH ROW EXECUTE FUNCTION platform_audit_log_before_insert();
--> statement-breakpoint
CREATE FUNCTION platform_audit_log_reject_mutation() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'platform_audit_log is append-only: % is not allowed', TG_OP
    USING ERRCODE = 'restrict_violation';
END
$$;
--> statement-breakpoint
CREATE TRIGGER platform_audit_log_append_only
  BEFORE UPDATE OR DELETE ON "platform_audit_log"
  FOR EACH ROW EXECUTE FUNCTION platform_audit_log_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER platform_audit_log_no_truncate
  BEFORE TRUNCATE ON "platform_audit_log"
  FOR EACH STATEMENT EXECUTE FUNCTION platform_audit_log_reject_mutation();
