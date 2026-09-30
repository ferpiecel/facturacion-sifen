-- Guard trigger (mirrors tenant_document_sequences_guard) + RLS + grants for tenant_request_sequences.
CREATE FUNCTION "tenant_request_sequences_guard"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  tenant_env public.tenant_environment;
BEGIN
  -- A tenant row hidden by RLS is left to the row-level security policy.
  SELECT t.environment INTO tenant_env FROM public.tenants t WHERE t.id = NEW.tenant_id;
  IF FOUND AND tenant_env IS DISTINCT FROM NEW.environment THEN
    RAISE EXCEPTION 'tenant_request_sequences: environment must match the tenant''s current environment';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
      OR NEW.environment IS DISTINCT FROM OLD.environment THEN
      RAISE EXCEPTION 'tenant_request_sequences: key columns are immutable';
    END IF;
    IF NEW.last_value IS DISTINCT FROM OLD.last_value + 1 THEN
      RAISE EXCEPTION 'tenant_request_sequences: last_value may only advance by 1';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "tenant_request_sequences_guard" BEFORE INSERT OR UPDATE ON "tenant_request_sequences"
FOR EACH ROW EXECUTE FUNCTION "tenant_request_sequences_guard"();
--> statement-breakpoint
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
