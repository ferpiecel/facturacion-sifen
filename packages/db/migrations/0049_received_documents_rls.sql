-- RLS + grants for received_documents (same pattern as 0047). The runtime role reads, inserts and
-- updates documents (the write guard of 0048 freezes identity); nothing is deleted, fiscal
-- documents are retained. No grant to partner_viewer: partners never see document content
-- (ADR-0014, ADR-0019).
ALTER TABLE "received_documents" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "received_documents" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "received_documents" TO app_user;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "received_documents" TO platform_admin;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "received_documents"
  TO app_user
  USING (tenant_id = nullif(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.current_tenant', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "platform_admin_all" ON "received_documents"
  TO platform_admin
  USING (true)
  WITH CHECK (true);
