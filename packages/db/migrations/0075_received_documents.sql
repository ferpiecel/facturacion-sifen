CREATE TABLE "received_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"source" varchar(16) NOT NULL,
	"status" varchar(32) DEFAULT 'received' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"needs_review" boolean DEFAULT false NOT NULL,
	"needs_review_reasons" text[] DEFAULT '{}' NOT NULL,
	"is_own_receiver" boolean DEFAULT true NOT NULL,
	"document_type" smallint,
	"cdc" char(44),
	"timbrado" varchar(8),
	"establishment_code" varchar(3),
	"expedition_point_code" varchar(3),
	"document_number" varchar(7),
	"series" varchar(2),
	"issuer_ruc_base" varchar(8),
	"issuer_ruc_dv" smallint,
	"issuer_legal_name" text,
	"issuer_trade_name" text,
	"issuer_address" text,
	"issuer_economic_activity" text,
	"receiver_ruc_base" varchar(8),
	"receiver_ruc_dv" smallint,
	"receiver_legal_name" text,
	"receiver_type" smallint,
	"issued_at" timestamp with time zone,
	"due_on" date,
	"paid_on" date,
	"payment_condition" varchar(8),
	"credit_term_days" integer,
	"payment_method" text,
	"currency" char(3) DEFAULT 'PYG' NOT NULL,
	"exchange_rate" numeric(23, 8),
	"total_exempt" numeric(23, 8),
	"total_zero_rated" numeric(23, 8),
	"taxable_5" numeric(23, 8),
	"taxable_10" numeric(23, 8),
	"vat_5" numeric(23, 8),
	"vat_10" numeric(23, 8),
	"total_vat" numeric(23, 8),
	"total_discount" numeric(23, 8),
	"total_amount" numeric(23, 8),
	"total_pyg" numeric(23, 8),
	"sifen_status" varchar(16) DEFAULT 'unknown' NOT NULL,
	"sifen_authorized_at" timestamp with time zone,
	"sifen_protocol_number" varchar(64),
	"confidence_overall" numeric(4, 3),
	"artifact_id" uuid,
	"raw_data" jsonb,
	"idempotency_key" varchar(255),
	"request_hash" char(64),
	"extraction_attempts" integer DEFAULT 0 NOT NULL,
	"extraction_error_code" varchar(64),
	"confirmed_at" timestamp with time zone,
	"confirmed_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "received_documents_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "received_documents_tenant_idempotency_key_key" UNIQUE("tenant_id","idempotency_key"),
	CONSTRAINT "received_documents_source_valid" CHECK ("received_documents"."source" IN ('sifen_xml', 'ekuatia_cdc', 'pdf', 'photo')),
	CONSTRAINT "received_documents_status_valid" CHECK ("received_documents"."status" IN ('received', 'extracting', 'extracted', 'needs_review', 'extraction_failed', 'confirmed')),
	CONSTRAINT "received_documents_version_positive" CHECK ("received_documents"."version" >= 1),
	CONSTRAINT "received_documents_needs_review_parity" CHECK ("received_documents"."needs_review" = ("received_documents"."status" = 'needs_review')),
	CONSTRAINT "received_documents_reasons_only_in_review" CHECK ("received_documents"."needs_review" OR cardinality("received_documents"."needs_review_reasons") = 0),
	CONSTRAINT "received_documents_document_type_valid" CHECK ("received_documents"."document_type" IS NULL OR "received_documents"."document_type" IN (1, 4, 5, 6, 7)),
	CONSTRAINT "received_documents_cdc_format" CHECK ("received_documents"."cdc" ~ '^[0-9]{44}$'),
	CONSTRAINT "received_documents_payment_condition_valid" CHECK ("received_documents"."payment_condition" IS NULL OR "received_documents"."payment_condition" IN ('cash', 'credit')),
	CONSTRAINT "received_documents_sifen_status_valid" CHECK ("received_documents"."sifen_status" IN ('unknown', 'approved', 'rejected', 'cancelled', 'voided', 'na')),
	CONSTRAINT "received_documents_confidence_range" CHECK ("received_documents"."confidence_overall" IS NULL OR ("received_documents"."confidence_overall" >= 0 AND "received_documents"."confidence_overall" <= 1)),
	CONSTRAINT "received_documents_error_code_format" CHECK ("received_documents"."extraction_error_code" ~ '^[a-z0-9_.-]{1,64}$'),
	CONSTRAINT "received_documents_idempotency_pair" CHECK (("received_documents"."idempotency_key" IS NULL) = ("received_documents"."request_hash" IS NULL)),
	CONSTRAINT "received_documents_idempotency_key_format" CHECK ("received_documents"."idempotency_key" ~ '^[!-~]{1,255}$'),
	CONSTRAINT "received_documents_idempotency_hash_format" CHECK ("received_documents"."request_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "received_documents" ADD CONSTRAINT "received_documents_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "received_documents" ADD CONSTRAINT "received_documents_artifact_fk" FOREIGN KEY ("tenant_id","artifact_id") REFERENCES "public"."received_artifacts"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "received_documents_tenant_cdc_idx" ON "received_documents" USING btree ("tenant_id","cdc") WHERE "received_documents"."cdc" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "received_documents_tenant_number_idx" ON "received_documents" USING btree ("tenant_id","issuer_ruc_base","timbrado","document_number") WHERE "received_documents"."issuer_ruc_base" IS NOT NULL AND "received_documents"."timbrado" IS NOT NULL AND "received_documents"."document_number" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "received_documents_tenant_updated_idx" ON "received_documents" USING btree ("tenant_id","updated_at" DESC,"id" DESC);--> statement-breakpoint
CREATE INDEX "received_documents_tenant_status_idx" ON "received_documents" USING btree ("tenant_id","status");
--> statement-breakpoint
-- Identity is frozen after insert; the CDC and the artifact are set at most once (a photo can reveal
-- its CDC, a CDC lookup attaches its XML, after the row exists); the version never decreases.
CREATE FUNCTION "received_documents_guard"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.source IS DISTINCT FROM OLD.source
    OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
    OR NEW.request_hash IS DISTINCT FROM OLD.request_hash
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'received_documents: identity columns are immutable';
  END IF;
  IF (OLD.cdc IS NOT NULL AND NEW.cdc IS DISTINCT FROM OLD.cdc)
    OR (OLD.artifact_id IS NOT NULL AND NEW.artifact_id IS DISTINCT FROM OLD.artifact_id) THEN
    RAISE EXCEPTION 'received_documents: cdc and artifact_id are write-once';
  END IF;
  IF NEW.version < OLD.version THEN
    RAISE EXCEPTION 'received_documents: version cannot decrease';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "received_documents_guard" BEFORE UPDATE ON "received_documents"
FOR EACH ROW EXECUTE FUNCTION "received_documents_guard"();
