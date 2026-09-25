-- RLS + grants for tenant_fiscal_profiles and
-- tenant_fiscal_economic_activities (same pattern as 0001_rls.sql /
-- 0003_api_keys_rls.sql): app_user is scoped to its own tenant, platform_admin
-- keeps deliberate cross-tenant access.
ALTER TABLE "tenant_fiscal_profiles" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "tenant_fiscal_profiles" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "tenant_fiscal_economic_activities" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "tenant_fiscal_economic_activities" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "tenant_fiscal_profiles" TO app_user;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "tenant_fiscal_profiles" TO platform_admin;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "tenant_fiscal_economic_activities" TO app_user;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "tenant_fiscal_economic_activities" TO platform_admin;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "tenant_fiscal_profiles"
  TO app_user
  USING (tenant_id = nullif(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.current_tenant', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "platform_admin_all" ON "tenant_fiscal_profiles"
  TO platform_admin
  USING (true)
  WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "tenant_fiscal_economic_activities"
  TO app_user
  USING (tenant_id = nullif(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.current_tenant', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "platform_admin_all" ON "tenant_fiscal_economic_activities"
  TO platform_admin
  USING (true)
  WITH CHECK (true);
