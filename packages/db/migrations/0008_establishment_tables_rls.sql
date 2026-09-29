-- RLS + grants for tenant_establishments, tenant_expedition_points and
-- tenant_timbrados (same pattern as 0001_rls.sql / 0006_fiscal_profiles_rls.sql):
-- app_user is scoped to its own tenant, platform_admin keeps deliberate
-- cross-tenant access.
ALTER TABLE "tenant_establishments" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "tenant_establishments" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "tenant_expedition_points" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "tenant_expedition_points" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "tenant_timbrados" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "tenant_timbrados" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "tenant_establishments" TO app_user;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "tenant_establishments" TO platform_admin;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "tenant_expedition_points" TO app_user;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "tenant_expedition_points" TO platform_admin;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "tenant_timbrados" TO app_user;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "tenant_timbrados" TO platform_admin;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "tenant_establishments"
  TO app_user
  USING (tenant_id = nullif(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.current_tenant', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "platform_admin_all" ON "tenant_establishments"
  TO platform_admin
  USING (true)
  WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "tenant_expedition_points"
  TO app_user
  USING (tenant_id = nullif(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.current_tenant', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "platform_admin_all" ON "tenant_expedition_points"
  TO platform_admin
  USING (true)
  WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "tenant_timbrados"
  TO app_user
  USING (tenant_id = nullif(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.current_tenant', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "platform_admin_all" ON "tenant_timbrados"
  TO platform_admin
  USING (true)
  WITH CHECK (true);
