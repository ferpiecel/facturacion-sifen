CREATE TABLE "ruc_blocks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"environment" "tenant_environment" NOT NULL,
	"blocked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"blocked_until" timestamp with time zone NOT NULL,
	"reason" text NOT NULL,
	CONSTRAINT "ruc_blocks_window" CHECK ("ruc_blocks"."blocked_until" > "ruc_blocks"."blocked_at"),
	CONSTRAINT "ruc_blocks_reason_length" CHECK (char_length("ruc_blocks"."reason") <= 500)
);
--> statement-breakpoint
ALTER TABLE "ruc_blocks" ADD CONSTRAINT "ruc_blocks_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ruc_blocks_active_idx" ON "ruc_blocks" USING btree ("tenant_id","environment","blocked_until");
--> statement-breakpoint
-- RLS + grants (same pattern as 0047): no UPDATE or DELETE, a pause is history.
ALTER TABLE "ruc_blocks" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "ruc_blocks" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT ON "ruc_blocks" TO app_user;
--> statement-breakpoint
GRANT SELECT, INSERT ON "ruc_blocks" TO platform_admin;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "ruc_blocks"
  TO app_user
  USING (tenant_id = nullif(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.current_tenant', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "platform_admin_all" ON "ruc_blocks"
  TO platform_admin
  USING (true)
  WITH CHECK (true);
