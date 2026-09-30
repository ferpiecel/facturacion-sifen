CREATE TABLE "tenant_cscs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"environment" "tenant_environment" NOT NULL,
	"id_csc" char(4) NOT NULL,
	"sealed" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenant_cscs_tenant_environment_id_csc_key" UNIQUE("tenant_id","environment","id_csc"),
	CONSTRAINT "tenant_cscs_id_csc_format" CHECK ("tenant_cscs"."id_csc" ~ '^[0-9]{4}$')
);
--> statement-breakpoint
ALTER TABLE "tenant_cscs" ADD CONSTRAINT "tenant_cscs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;