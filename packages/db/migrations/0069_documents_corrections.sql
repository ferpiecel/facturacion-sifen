CREATE TABLE "document_corrections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"kind" varchar(16) NOT NULL,
	"idempotency_key" varchar(255) NOT NULL,
	"request_hash" char(64) NOT NULL,
	"previous_payload" jsonb NOT NULL,
	"previous_sifen_messages" jsonb,
	"replacement_document_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_corrections_tenant_idempotency_key_key" UNIQUE("tenant_id","idempotency_key"),
	CONSTRAINT "document_corrections_kind_valid" CHECK ("document_corrections"."kind" IN ('same_cdc', 'reissue')),
	CONSTRAINT "document_corrections_replacement" CHECK (("document_corrections"."kind" = 'reissue') = ("document_corrections"."replacement_document_id" IS NOT NULL)),
	CONSTRAINT "document_corrections_hash_format" CHECK ("document_corrections"."request_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "corrections_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "document_corrections" ADD CONSTRAINT "document_corrections_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_corrections" ADD CONSTRAINT "document_corrections_tenant_document_fk" FOREIGN KEY ("tenant_id","document_id") REFERENCES "public"."documents"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_corrections" ADD CONSTRAINT "document_corrections_tenant_replacement_fk" FOREIGN KEY ("tenant_id","replacement_document_id") REFERENCES "public"."documents"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "document_corrections_reissue_idx" ON "document_corrections" USING btree ("tenant_id","document_id") WHERE "document_corrections"."kind" = 'reissue';--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_corrections_count_range" CHECK ("documents"."corrections_count" >= 0);
--> statement-breakpoint
-- HU-E8-01 (ADR-0021): documents_guard of 0034 plus one door, `rejected -> accepted` with corrections_count + 1.
CREATE OR REPLACE FUNCTION "documents_guard"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  tenant_env public.tenant_environment;
  door_ok boolean;
  stamping boolean;
  correcting boolean;
BEGIN
  -- A tenant row hidden by RLS is left to the row-level security policy.
  SELECT t.environment INTO tenant_env FROM public.tenants t WHERE t.id = NEW.tenant_id;
  IF FOUND AND tenant_env IS DISTINCT FROM NEW.environment THEN
    RAISE EXCEPTION 'documents: environment must match the tenant''s current environment';
  END IF;
  -- resent_at is only ever set by the recovery queueing a document again (HU-E6-04), never on INSERT.
  IF TG_OP = 'INSERT' AND NEW.resent_at IS NOT NULL THEN
    RAISE EXCEPTION 'documents: resent_at can only be set when the recovery queues the document again';
  END IF;
  IF TG_OP = 'INSERT' AND NEW.corrections_count <> 0 THEN
    RAISE EXCEPTION 'documents: corrections_count starts at 0 (it only moves through a correction)';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    -- HU-E8-01, ADR-0021: the one way a rejected document is rewritten and queued again with the same CDC.
    correcting := OLD.status = 'rejected' AND NEW.status = 'accepted'
      AND NEW.corrections_count = OLD.corrections_count + 1;
    IF NEW.corrections_count IS DISTINCT FROM OLD.corrections_count AND NOT correcting THEN
      RAISE EXCEPTION 'documents: corrections_count only moves when a rejected document is corrected';
    END IF;
    IF correcting AND (NEW.signed_xml IS NOT NULL OR NEW.signed_at IS NOT NULL) THEN
      RAISE EXCEPTION 'documents: a corrected document must be signed again';
    END IF;
    IF NEW.id IS DISTINCT FROM OLD.id
      OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
      OR NEW.environment IS DISTINCT FROM OLD.environment
      OR NEW.cdc IS DISTINCT FROM OLD.cdc
      OR NEW.document_type IS DISTINCT FROM OLD.document_type
      OR NEW.timbrado_id IS DISTINCT FROM OLD.timbrado_id
      OR NEW.establishment_id IS DISTINCT FROM OLD.establishment_id
      OR NEW.expedition_point_id IS DISTINCT FROM OLD.expedition_point_id
      OR NEW.series IS DISTINCT FROM OLD.series
      OR NEW.number IS DISTINCT FROM OLD.number
      OR NEW.security_code IS DISTINCT FROM OLD.security_code
      OR (NOT correcting AND NEW.receiver_ruc IS DISTINCT FROM OLD.receiver_ruc)
      OR NEW.issued_at IS DISTINCT FROM OLD.issued_at
      OR (NOT correcting AND NEW.total_amount IS DISTINCT FROM OLD.total_amount)
      OR NEW.currency IS DISTINCT FROM OLD.currency
      OR (NOT correcting AND NEW.payload IS DISTINCT FROM OLD.payload)
      OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
      OR NEW.request_hash IS DISTINCT FROM OLD.request_hash
      OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'documents: identity columns are immutable';
    END IF;
    -- The signed XML and its instant are set once (HU-E6-02).
    IF NOT correcting AND (
      (OLD.signed_xml IS NOT NULL AND NEW.signed_xml IS DISTINCT FROM OLD.signed_xml)
      OR (OLD.signed_at IS NOT NULL AND NEW.signed_at IS DISTINCT FROM OLD.signed_at)
    ) THEN
      RAISE EXCEPTION 'documents: signed_xml and signed_at are write-once';
    END IF;
    -- ...and only while the document is (or becomes) signed (rank below submitted).
    IF (OLD.signed_xml IS NULL AND NEW.signed_xml IS NOT NULL)
      OR (OLD.signed_at IS NULL AND NEW.signed_at IS NOT NULL) THEN
      IF NEW.status IS DISTINCT FROM 'signed'
        OR public.documents_status_rank(OLD.status) >= public.documents_status_rank('submitted') THEN
        RAISE EXCEPTION 'documents: signed_xml and signed_at can only be set while signing';
      END IF;
    END IF;
    -- The resend stamp is set once (HU-E6-04).
    IF OLD.resent_at IS NOT NULL AND NEW.resent_at IS DISTINCT FROM OLD.resent_at THEN
      RAISE EXCEPTION 'documents: resent_at is write-once';
    END IF;
    -- The one way to set it, and the one way back from submitted: the recovery queues the document
    -- again. Stamped now, the attempt counted (+1), nothing holds it and one of its lotes has given up
    -- on it (recovery, unknown or processed). A submitted or an already queued document (the one of an
    -- unanswered send) may be stamped, always ending queued.
    stamping := OLD.resent_at IS NULL AND NEW.resent_at IS NOT NULL;
    IF stamping THEN
      IF NOT (OLD.status IN ('submitted', 'queued') AND NEW.status = 'queued') THEN
        RAISE EXCEPTION 'documents: resent_at can only be set when the recovery queues the document again';
      END IF;
      door_ok := NEW.transmission_attempts = OLD.transmission_attempts + 1
        AND NEW.transmission_hold IS NULL
        AND EXISTS (
          SELECT 1
          FROM public.lote_documents ld
          JOIN public.lotes l ON l.tenant_id = ld.tenant_id AND l.id = ld.lote_id
          WHERE ld.tenant_id = NEW.tenant_id
            AND ld.document_id = NEW.id
            AND l.status IN ('recovery', 'unknown', 'processed')
        );
      IF NOT door_ok THEN
        IF OLD.status = 'submitted' THEN
          RAISE EXCEPTION 'documents: invalid status transition % -> %', OLD.status, NEW.status;
        END IF;
        RAISE EXCEPTION 'documents: resent_at can only be set when the recovery queues the document again';
      END IF;
    END IF;
    -- Statuses only move forward; a SIFEN outcome is entered once, from submitted (HU-E6-03).
    IF NEW.status IS DISTINCT FROM OLD.status AND NOT correcting THEN
      IF public.documents_status_rank(NEW.status) IS NULL
        OR public.documents_status_rank(OLD.status) IS NULL THEN
        RAISE EXCEPTION 'documents: unranked status % -> %', OLD.status, NEW.status;
      END IF;
      IF OLD.status = 'submitted' AND NEW.status = 'queued' THEN
        IF NOT stamping THEN
          RAISE EXCEPTION 'documents: invalid status transition % -> %', OLD.status, NEW.status;
        END IF;
      ELSIF NOT (
        public.documents_status_rank(NEW.status) > public.documents_status_rank(OLD.status)
        AND (public.documents_status_rank(NEW.status) <> 4 OR OLD.status = 'submitted')
      ) THEN
        RAISE EXCEPTION 'documents: invalid status transition % -> %', OLD.status, NEW.status;
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
ALTER TABLE "document_corrections" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "document_corrections" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT ON "document_corrections" TO app_user;
--> statement-breakpoint
GRANT SELECT, INSERT ON "document_corrections" TO platform_admin;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "document_corrections"
  TO app_user
  USING (tenant_id = nullif(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.current_tenant', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "platform_admin_all" ON "document_corrections"
  TO platform_admin
  USING (true)
  WITH CHECK (true);
--> statement-breakpoint
CREATE FUNCTION "document_corrections_append_only"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'document_corrections: rows are append-only';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "document_corrections_append_only" BEFORE UPDATE OR DELETE ON "document_corrections"
FOR EACH ROW EXECUTE FUNCTION "document_corrections_append_only"();
