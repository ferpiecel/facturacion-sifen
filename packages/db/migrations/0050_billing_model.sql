CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"subscription_id" uuid NOT NULL,
	"amount" bigint NOT NULL,
	"currency" char(3) DEFAULT 'PYG' NOT NULL,
	"method" text DEFAULT 'manual' NOT NULL,
	"reference" text,
	"paid_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payments_amount_positive" CHECK ("payments"."amount" > 0),
	CONSTRAINT "payments_method_valid" CHECK ("payments"."method" IN ('manual'))
);
--> statement-breakpoint
CREATE TABLE "plan_price_tiers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plan_price_id" uuid NOT NULL,
	"from_documents" integer NOT NULL,
	"unit_price" bigint NOT NULL,
	CONSTRAINT "plan_price_tiers_price_from_key" UNIQUE("plan_price_id","from_documents"),
	CONSTRAINT "plan_price_tiers_amounts_nonneg" CHECK ("plan_price_tiers"."from_documents" >= 0 AND "plan_price_tiers"."unit_price" >= 0)
);
--> statement-breakpoint
CREATE TABLE "plan_prices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plan_id" uuid NOT NULL,
	"monthly_price" bigint NOT NULL,
	"included_documents" integer NOT NULL,
	"overage_price" bigint NOT NULL,
	"valid_from" date NOT NULL,
	"valid_to" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plan_prices_amounts_nonneg" CHECK ("plan_prices"."monthly_price" >= 0 AND "plan_prices"."included_documents" >= 0 AND "plan_prices"."overage_price" >= 0),
	CONSTRAINT "plan_prices_valid_range" CHECK ("plan_prices"."valid_to" IS NULL OR "plan_prices"."valid_to" >= "plan_prices"."valid_from")
);
--> statement-breakpoint
CREATE TABLE "plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" varchar(64) NOT NULL,
	"name" varchar(255) NOT NULL,
	"currency" char(3) DEFAULT 'PYG' NOT NULL,
	"api_call_limit" integer,
	"features" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plans_code_unique" UNIQUE("code"),
	CONSTRAINT "plans_code_format" CHECK ("plans"."code" ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
	CONSTRAINT "plans_api_call_limit_nonneg" CHECK ("plans"."api_call_limit" IS NULL OR "plans"."api_call_limit" >= 0)
);
--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"plan_id" uuid NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"starts_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ends_at" timestamp with time zone,
	"next_billing_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subscriptions_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "subscriptions_status_valid" CHECK ("subscriptions"."status" IN ('trialing', 'active', 'past_due', 'cancelled')),
	CONSTRAINT "subscriptions_period_valid" CHECK ("subscriptions"."ends_at" IS NULL OR "subscriptions"."ends_at" >= "subscriptions"."starts_at")
);
--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_subscription_fk" FOREIGN KEY ("tenant_id","subscription_id") REFERENCES "public"."subscriptions"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_price_tiers" ADD CONSTRAINT "plan_price_tiers_plan_price_id_plan_prices_id_fk" FOREIGN KEY ("plan_price_id") REFERENCES "public"."plan_prices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_prices" ADD CONSTRAINT "plan_prices_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "subscriptions_one_live_per_tenant" ON "subscriptions" USING btree ("tenant_id") WHERE "subscriptions"."status" <> 'cancelled';
--> statement-breakpoint
-- HU-E15-01: RLS and grants, hand-written (same pattern as 0028). Plans are platform data: every
-- app_user may read them, only platform_admin writes. Subscriptions and payments are written by ops
-- (platform_admin) and only read by the tenant; payments are append-only.
ALTER TABLE "plans" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "plans" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT ON "plans" TO app_user;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "plans" TO platform_admin;
--> statement-breakpoint
CREATE POLICY "plans_read" ON "plans" FOR SELECT TO app_user USING (true);
--> statement-breakpoint
CREATE POLICY "platform_admin_all" ON "plans" TO platform_admin USING (true) WITH CHECK (true);
--> statement-breakpoint
ALTER TABLE "subscriptions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "subscriptions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT ON "subscriptions" TO app_user;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "subscriptions" TO platform_admin;
--> statement-breakpoint
ALTER TABLE "payments" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "payments" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT ON "payments" TO app_user;
--> statement-breakpoint
GRANT SELECT, INSERT ON "payments" TO platform_admin;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "subscriptions" TO app_user
  USING (tenant_id = nullif(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.current_tenant', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "platform_admin_all" ON "subscriptions" TO platform_admin USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "payments" TO app_user
  USING (tenant_id = nullif(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.current_tenant', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "platform_admin_all" ON "payments" TO platform_admin USING (true) WITH CHECK (true);
--> statement-breakpoint
-- Effective-dated prices: no two validity ranges of the same plan may overlap.
CREATE EXTENSION IF NOT EXISTS btree_gist;
--> statement-breakpoint
ALTER TABLE "plan_prices" ADD CONSTRAINT "plan_prices_no_overlap" EXCLUDE USING gist ("plan_id" WITH =, daterange("valid_from", "valid_to", '[]') WITH &&);
--> statement-breakpoint
ALTER TABLE "plan_prices" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "plan_prices" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT ON "plan_prices" TO app_user;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "plan_prices" TO platform_admin;
--> statement-breakpoint
CREATE POLICY "plan_prices_read" ON "plan_prices" FOR SELECT TO app_user USING (true);
--> statement-breakpoint
CREATE POLICY "platform_admin_all" ON "plan_prices" TO platform_admin USING (true) WITH CHECK (true);
--> statement-breakpoint
ALTER TABLE "plan_price_tiers" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "plan_price_tiers" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT ON "plan_price_tiers" TO app_user;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "plan_price_tiers" TO platform_admin;
--> statement-breakpoint
CREATE POLICY "plan_price_tiers_read" ON "plan_price_tiers" FOR SELECT TO app_user USING (true);
--> statement-breakpoint
CREATE POLICY "platform_admin_all" ON "plan_price_tiers" TO platform_admin USING (true) WITH CHECK (true);
