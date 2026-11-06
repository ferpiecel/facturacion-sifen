-- RLS + grants for received_artifacts (same pattern as 0020/0029). The runtime role can read and
-- insert artifacts and fill in `page_count` once a PDF is inspected; the identity, hash and key
-- columns are never updated and nothing is deleted (artifacts are retained, Q8 of the reception
-- plan). No grant to partner_viewer: partners never see document content (ADR-0014, ADR-0019).
ALTER TABLE "received_artifacts" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "received_artifacts" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT ON "received_artifacts" TO app_user;
--> statement-breakpoint
GRANT UPDATE ("page_count", "updated_at") ON "received_artifacts" TO app_user;
--> statement-breakpoint
GRANT SELECT, INSERT ON "received_artifacts" TO platform_admin;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "received_artifacts"
  TO app_user
  USING (tenant_id = nullif(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.current_tenant', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "platform_admin_all" ON "received_artifacts"
  TO platform_admin
  USING (true)
  WITH CHECK (true);
