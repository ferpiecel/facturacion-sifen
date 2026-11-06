-- RLS + grants for received_document_items and received_document_field_confidences (same pattern
-- as 0049). Both are edited through the document PATCH, so the runtime role reads, inserts and
-- updates; nothing is deleted, fiscal documents are retained. No grant to partner_viewer:
-- partners never see document content (ADR-0014, ADR-0019).
ALTER TABLE "received_document_items" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "received_document_items" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "received_document_field_confidences" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "received_document_field_confidences" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "received_document_items" TO app_user;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "received_document_items" TO platform_admin;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "received_document_field_confidences" TO app_user;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "received_document_field_confidences" TO platform_admin;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "received_document_items"
  TO app_user
  USING (tenant_id = nullif(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.current_tenant', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "platform_admin_all" ON "received_document_items"
  TO platform_admin
  USING (true)
  WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "received_document_field_confidences"
  TO app_user
  USING (tenant_id = nullif(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.current_tenant', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "platform_admin_all" ON "received_document_field_confidences"
  TO platform_admin
  USING (true)
  WITH CHECK (true);
