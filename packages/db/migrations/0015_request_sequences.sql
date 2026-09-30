CREATE TABLE "tenant_request_sequences" (
	"tenant_id" uuid NOT NULL,
	"environment" "tenant_environment" NOT NULL,
	"last_value" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "tenant_request_sequences_pkey" PRIMARY KEY("tenant_id","environment"),
	CONSTRAINT "tenant_request_sequences_last_value_range" CHECK ("tenant_request_sequences"."last_value" BETWEEN 0 AND 999999999999999)
);
--> statement-breakpoint
ALTER TABLE "tenant_request_sequences" ADD CONSTRAINT "tenant_request_sequences_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;