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
CREATE TABLE "plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" varchar(64) NOT NULL,
	"name" varchar(255) NOT NULL,
	"currency" char(3) DEFAULT 'PYG' NOT NULL,
	"monthly_price" bigint,
	"document_limit" integer,
	"api_call_limit" integer,
	"features" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plans_code_unique" UNIQUE("code"),
	CONSTRAINT "plans_code_format" CHECK ("plans"."code" ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
	CONSTRAINT "plans_monthly_price_nonneg" CHECK ("plans"."monthly_price" IS NULL OR "plans"."monthly_price" >= 0),
	CONSTRAINT "plans_document_limit_nonneg" CHECK ("plans"."document_limit" IS NULL OR "plans"."document_limit" >= 0),
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
	CONSTRAINT "subscriptions_status_valid" CHECK ("subscriptions"."status" IN ('trialing', 'active', 'past_due', 'cancelled'))
);
--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_subscription_fk" FOREIGN KEY ("tenant_id","subscription_id") REFERENCES "public"."subscriptions"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "subscriptions_one_live_per_tenant" ON "subscriptions" USING btree ("tenant_id") WHERE "subscriptions"."status" <> 'cancelled';
--> statement-breakpoint
-- HU-E15-01: RLS and grants, hand-written (same pattern as 0028). Plans are platform data: every
-- app_user may read them, only platform_admin writes. Subscriptions, payments and SaaS invoices are
-- written by ops (platform_admin) and only read by the tenant; payments are append-only.
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
