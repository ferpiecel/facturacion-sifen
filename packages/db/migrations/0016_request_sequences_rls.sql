-- RLS + grants for tenant_request_sequences (same as 0012).
ALTER TABLE "tenant_request_sequences" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "tenant_request_sequences" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "tenant_request_sequences" TO app_user;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "tenant_request_sequences" TO platform_admin;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "tenant_request_sequences"
  TO app_user
  USING (tenant_id = nullif(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.current_tenant', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "platform_admin_all" ON "tenant_request_sequences"
  TO platform_admin
  USING (true)
  WITH CHECK (true);
