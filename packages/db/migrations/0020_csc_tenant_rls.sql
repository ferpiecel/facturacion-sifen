CREATE FUNCTION "tenant_cscs_immutable_identity"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.environment IS DISTINCT FROM OLD.environment THEN
    RAISE EXCEPTION 'tenant_cscs: tenant_id and environment are immutable';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "tenant_cscs_immutable_identity" BEFORE UPDATE ON "tenant_cscs"
FOR EACH ROW EXECUTE FUNCTION "tenant_cscs_immutable_identity"();
--> statement-breakpoint
ALTER TABLE "tenant_cscs" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "tenant_cscs" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT ON "tenant_cscs" TO app_user;
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON "tenant_cscs" TO platform_admin;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "tenant_cscs"
  TO app_user
  USING (tenant_id = nullif(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.current_tenant', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "platform_admin_all" ON "tenant_cscs"
  TO platform_admin
  USING (true)
  WITH CHECK (true);
