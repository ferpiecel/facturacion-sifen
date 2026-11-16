-- Daily extraction counter per tenant (reception R5.9). Table (generated) followed by RLS and
-- grants (hand-written, same pattern as 0076). The runtime role reads, inserts and updates the
-- counter; nothing is deleted. No grant to partner_viewer (ADR-0014, ADR-0024).
CREATE TABLE "reception_extraction_usage" (
	"tenant_id" uuid NOT NULL,
	"usage_date" date NOT NULL,
	"used" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reception_extraction_usage_tenant_id_usage_date_pk" PRIMARY KEY("tenant_id","usage_date"),
	CONSTRAINT "reception_extraction_usage_used_nonneg" CHECK ("reception_extraction_usage"."used" >= 0)
);
--> statement-breakpoint
ALTER TABLE "reception_extraction_usage" ADD CONSTRAINT "reception_extraction_usage_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "reception_extraction_usage" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "reception_extraction_usage" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "reception_extraction_usage" TO app_user;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "reception_extraction_usage" TO platform_admin;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "reception_extraction_usage"
  TO app_user
  USING (tenant_id = nullif(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.current_tenant', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "platform_admin_all" ON "reception_extraction_usage"
  TO platform_admin
  USING (true)
  WITH CHECK (true);
