-- RLS + grants for tenant_document_sequences (same pattern as
-- 0008_establishment_tables_rls.sql): app_user is scoped to its own tenant,
-- platform_admin keeps deliberate cross-tenant access.
ALTER TABLE "tenant_document_sequences" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "tenant_document_sequences" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "tenant_document_sequences" TO app_user;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "tenant_document_sequences" TO platform_admin;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "tenant_document_sequences"
  TO app_user
  USING (tenant_id = nullif(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.current_tenant', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "platform_admin_all" ON "tenant_document_sequences"
  TO platform_admin
  USING (true)
  WITH CHECK (true);
