CREATE TYPE "public"."fiscal_taxpayer_type" AS ENUM('persona_fisica', 'persona_juridica');--> statement-breakpoint
CREATE TABLE "tenant_fiscal_economic_activities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"code" varchar(8) NOT NULL,
	"description" varchar(300) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenant_fiscal_economic_activities_code_format" CHECK ("tenant_fiscal_economic_activities"."code" ~ '^[A-Za-z0-9]{1,8}$')
);
--> statement-breakpoint
CREATE TABLE "tenant_fiscal_profiles" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"ruc_base" varchar(8) NOT NULL,
	"ruc_dv" smallint NOT NULL,
	"legal_name" varchar(255) NOT NULL,
	"trade_name" varchar(255),
	"taxpayer_type" "fiscal_taxpayer_type" NOT NULL,
	"regime_code" varchar(2),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenant_fiscal_profiles_ruc_base_format" CHECK ("tenant_fiscal_profiles"."ruc_base" ~ '^[0-9]{3,8}$'),
	CONSTRAINT "tenant_fiscal_profiles_ruc_dv_range" CHECK ("tenant_fiscal_profiles"."ruc_dv" BETWEEN 0 AND 9),
	CONSTRAINT "tenant_fiscal_profiles_regime_code_format" CHECK ("tenant_fiscal_profiles"."regime_code" IS NULL OR "tenant_fiscal_profiles"."regime_code" ~ '^[0-9]{1,2}$')
);
--> statement-breakpoint
ALTER TABLE "tenant_fiscal_economic_activities" ADD CONSTRAINT "tenant_fiscal_economic_activities_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_fiscal_profiles" ADD CONSTRAINT "tenant_fiscal_profiles_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tenant_fiscal_economic_activities_tenant_id_idx" ON "tenant_fiscal_economic_activities" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_fiscal_economic_activities_tenant_code_idx" ON "tenant_fiscal_economic_activities" USING btree ("tenant_id","code");