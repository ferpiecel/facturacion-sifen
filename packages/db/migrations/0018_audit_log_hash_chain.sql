ALTER TABLE "audit_log" ADD COLUMN "seq" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "prev_hash" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "hash" text DEFAULT '' NOT NULL;--> statement-breakpoint
--> statement-breakpoint
-- Per-tenant SHA-256 hash chain (HU-E13-02, RNF-08). The hash is computed by
-- the database, never by the app: canonical form is the JSON array text of
-- (tenant_id, id, seq, occurred_at UTC, actor, action, entity, before, after,
-- prev_hash), hashed with the built-in sha256(). Genesis prev_hash = 64 zeros.
CREATE FUNCTION audit_log_compute_hash(
  p_tenant_id uuid, p_id uuid, p_seq bigint, p_occurred_at timestamptz,
  p_actor_type text, p_actor_id text, p_action text, p_entity_type text,
  p_entity_id text, p_before jsonb, p_after jsonb, p_prev_hash text
) RETURNS text
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog, pg_temp AS $$
  SELECT encode(sha256(convert_to(jsonb_build_array(
    p_tenant_id, p_id, p_seq,
    to_char(p_occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US'),
    p_actor_type, p_actor_id, p_action, p_entity_type, p_entity_id,
    p_before, p_after, p_prev_hash)::text, 'UTF8')), 'hex')
$$;
--> statement-breakpoint
-- Backfill rows written before the chain existed, in (occurred_at, id) order.
-- audit_log has FORCE ROW LEVEL SECURITY (0014), which also applies to a
-- non-superuser table owner and would hide every row, so the function lifts
-- FORCE for its own transaction and restores it. It is left installed (owner
-- only) so the chain can be rebuilt after a maintenance restore.
CREATE FUNCTION audit_log_backfill_chain() RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  r record;
  last_tenant uuid;
  n bigint;
  prev text;
  cur_prev text;
BEGIN
  ALTER TABLE public.audit_log NO FORCE ROW LEVEL SECURITY;
  ALTER TABLE public.audit_log DISABLE TRIGGER audit_log_append_only;
  FOR r IN SELECT * FROM public.audit_log ORDER BY tenant_id, occurred_at, id LOOP
    IF last_tenant IS DISTINCT FROM r.tenant_id THEN
      last_tenant := r.tenant_id; n := 0; prev := repeat('0', 64);
    END IF;
    n := n + 1;
    cur_prev := prev;
    prev := public.audit_log_compute_hash(r.tenant_id, r.id, n, r.occurred_at,
      r.actor_type::text, r.actor_id, r.action, r.entity_type, r.entity_id,
      r.before, r.after, cur_prev);
    UPDATE public.audit_log SET seq = n, prev_hash = cur_prev, hash = prev WHERE id = r.id;
  END LOOP;
  ALTER TABLE public.audit_log ENABLE TRIGGER audit_log_append_only;
  ALTER TABLE public.audit_log FORCE ROW LEVEL SECURITY;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION audit_log_backfill_chain() FROM PUBLIC;
--> statement-breakpoint
SELECT audit_log_backfill_chain();
--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_tenant_seq_unique" UNIQUE("tenant_id","seq");
--> statement-breakpoint
CREATE FUNCTION audit_log_chain_hash() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  last_seq bigint;
  last_hash text;
BEGIN
  -- One appender per tenant at a time. The lock is held until the surrounding
  -- transaction ends, so keep audit writes at the end of the business
  -- transaction. Under REPEATABLE READ/SERIALIZABLE the snapshot may predate
  -- the lock and read a stale head; the insert then fails loudly on
  -- audit_log_tenant_seq_unique instead of forking the chain (retry the tx).
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.tenant_id::text, 0));
  SELECT a.seq, a.hash INTO last_seq, last_hash
    FROM public.audit_log a WHERE a.tenant_id = NEW.tenant_id
    ORDER BY a.seq DESC LIMIT 1;
  NEW.seq := coalesce(last_seq, 0) + 1;
  NEW.prev_hash := coalesce(last_hash, repeat('0', 64));
  NEW.hash := public.audit_log_compute_hash(NEW.tenant_id, NEW.id, NEW.seq,
    NEW.occurred_at, NEW.actor_type::text, NEW.actor_id, NEW.action,
    NEW.entity_type, NEW.entity_id, NEW.before, NEW.after, NEW.prev_hash);
  RETURN NEW;
END
$$;
--> statement-breakpoint
-- Named so it fires after audit_log_force_occurred_at (alphabetical order).
CREATE TRIGGER audit_log_hash_chain
  BEFORE INSERT ON "audit_log"
  FOR EACH ROW EXECUTE FUNCTION audit_log_chain_hash();
