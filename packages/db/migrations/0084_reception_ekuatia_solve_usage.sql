-- Paid eKuatia solve counters (reception R6.3, ADR-0027 point 4). Tables (generated) followed by
-- RLS and grants (hand-written, same pattern as 0083). The per-tenant table is isolated by RLS; the
-- global table has no tenant_id (an aggregate counter) and no RLS. The runtime role reads, inserts
-- and updates both; nothing is deleted. No grant to partner_viewer (ADR-0014, ADR-0024).
CREATE TABLE "reception_ekuatia_global_usage" (
	"usage_date" date PRIMARY KEY NOT NULL,
	"used" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reception_ekuatia_global_usage_used_nonneg" CHECK ("reception_ekuatia_global_usage"."used" >= 0)
);
--> statement-breakpoint
CREATE TABLE "reception_ekuatia_solve_usage" (
	"tenant_id" uuid NOT NULL,
	"usage_date" date NOT NULL,
	"used" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reception_ekuatia_solve_usage_tenant_id_usage_date_pk" PRIMARY KEY("tenant_id","usage_date"),
	CONSTRAINT "reception_ekuatia_solve_usage_used_nonneg" CHECK ("reception_ekuatia_solve_usage"."used" >= 0)
);
--> statement-breakpoint
ALTER TABLE "reception_ekuatia_solve_usage" ADD CONSTRAINT "reception_ekuatia_solve_usage_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "reception_ekuatia_solve_usage" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "reception_ekuatia_solve_usage" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "reception_ekuatia_solve_usage" TO app_user;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "reception_ekuatia_solve_usage" TO platform_admin;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "reception_ekuatia_global_usage" TO app_user;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "reception_ekuatia_global_usage" TO platform_admin;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "reception_ekuatia_solve_usage"
  TO app_user
  USING (tenant_id = nullif(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.current_tenant', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "platform_admin_all" ON "reception_ekuatia_solve_usage"
  TO platform_admin
  USING (true)
  WITH CHECK (true);
