-- Limit trigger (max 2 CSC per tenant and environment) + RLS + grants for tenant_cscs.
CREATE FUNCTION "tenant_cscs_enforce_limit"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  -- Serializes concurrent inserts for the same (tenant, environment) so the count cannot race.
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.tenant_id::text || ':' || NEW.environment::text, 0));
  IF (SELECT count(*) FROM public.tenant_cscs c
      WHERE c.tenant_id = NEW.tenant_id AND c.environment = NEW.environment) >= 2 THEN
    RAISE EXCEPTION 'tenant_cscs: at most 2 CSC per environment';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "tenant_cscs_enforce_limit" BEFORE INSERT ON "tenant_cscs"
FOR EACH ROW EXECUTE FUNCTION "tenant_cscs_enforce_limit"();
--> statement-breakpoint
ALTER TABLE "tenant_cscs" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "tenant_cscs" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON "tenant_cscs" TO app_user;
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
