CREATE TABLE "received_artifacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"storage_key" text NOT NULL,
	"content_type" varchar(255),
	"sha256" char(64) NOT NULL,
	"size_bytes" bigint NOT NULL,
	"original_name" text,
	"page_count" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "received_artifacts_storage_key_key" UNIQUE("storage_key"),
	CONSTRAINT "received_artifacts_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "received_artifacts_tenant_sha256_key" UNIQUE("tenant_id","sha256"),
	CONSTRAINT "received_artifacts_sha256_hex" CHECK ("received_artifacts"."sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "received_artifacts_size_nonneg" CHECK ("received_artifacts"."size_bytes" >= 0),
	CONSTRAINT "received_artifacts_page_count_positive" CHECK ("received_artifacts"."page_count" IS NULL OR "received_artifacts"."page_count" > 0)
);
--> statement-breakpoint
ALTER TABLE "received_artifacts" ADD CONSTRAINT "received_artifacts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;