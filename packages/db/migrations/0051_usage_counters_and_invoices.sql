CREATE TABLE "invoices_saas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"subscription_id" uuid NOT NULL,
	"period" date NOT NULL,
	"amount" bigint NOT NULL,
	"currency" char(3) DEFAULT 'PYG' NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"issued_at" timestamp with time zone,
	"pdf_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invoices_saas_subscription_period_key" UNIQUE("subscription_id","period"),
	CONSTRAINT "invoices_saas_amount_nonneg" CHECK ("invoices_saas"."amount" >= 0),
	CONSTRAINT "invoices_saas_period_first_day" CHECK ("invoices_saas"."period" = date_trunc('month', "invoices_saas"."period"::timestamp)::date),
	CONSTRAINT "invoices_saas_status_valid" CHECK ("invoices_saas"."status" IN ('draft', 'issued', 'paid', 'void'))
);
--> statement-breakpoint
CREATE TABLE "usage_counters" (
	"tenant_id" uuid NOT NULL,
	"period" date NOT NULL,
	"documents_issued" bigint DEFAULT 0 NOT NULL,
	"api_calls" bigint DEFAULT 0 NOT NULL,
	"notifications_sent" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "usage_counters_pkey" PRIMARY KEY("tenant_id","period"),
	CONSTRAINT "usage_counters_period_first_day" CHECK ("usage_counters"."period" = date_trunc('month', "usage_counters"."period"::timestamp)::date),
	CONSTRAINT "usage_counters_nonneg" CHECK ("usage_counters"."documents_issued" >= 0 AND "usage_counters"."api_calls" >= 0 AND "usage_counters"."notifications_sent" >= 0)
);
--> statement-breakpoint
ALTER TABLE "invoices_saas" ADD CONSTRAINT "invoices_saas_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices_saas" ADD CONSTRAINT "invoices_saas_subscription_fk" FOREIGN KEY ("tenant_id","subscription_id") REFERENCES "public"."subscriptions"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_counters" ADD CONSTRAINT "usage_counters_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
-- HU-E15-01/02: RLS and grants, hand-written (same pattern as 0050). Invoices are written by ops
-- (platform_admin) and only read by the tenant; counters are incremented inside the tenant transaction.
ALTER TABLE "invoices_saas" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "invoices_saas" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT ON "invoices_saas" TO app_user;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "invoices_saas" TO platform_admin;
--> statement-breakpoint
ALTER TABLE "usage_counters" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "usage_counters" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "usage_counters" TO app_user;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "usage_counters" TO platform_admin;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "invoices_saas" TO app_user
  USING (tenant_id = nullif(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.current_tenant', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "platform_admin_all" ON "invoices_saas" TO platform_admin USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "usage_counters" TO app_user
  USING (tenant_id = nullif(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.current_tenant', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "platform_admin_all" ON "usage_counters" TO platform_admin USING (true) WITH CHECK (true);
--> statement-breakpoint
-- Counters only go up and keep their identity; updated_at is maintained here.
CREATE FUNCTION "usage_counters_guard"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.period IS DISTINCT FROM OLD.period THEN
    RAISE EXCEPTION 'usage_counters: identity columns are immutable';
  END IF;
  IF NEW.documents_issued < OLD.documents_issued
    OR NEW.api_calls < OLD.api_calls
    OR NEW.notifications_sent < OLD.notifications_sent THEN
    RAISE EXCEPTION 'usage_counters: counters can only increase';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "usage_counters_guard" BEFORE UPDATE ON "usage_counters"
FOR EACH ROW EXECUTE FUNCTION "usage_counters_guard"();
