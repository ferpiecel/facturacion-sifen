CREATE TABLE "tenant_establishments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"code" varchar(3) NOT NULL,
	"address" varchar(255) NOT NULL,
	"department_code" varchar(2) NOT NULL,
	"district_code" varchar(4) NOT NULL,
	"city_code" varchar(5) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenant_establishments_code_format" CHECK ("tenant_establishments"."code" ~ '^[0-9]{3}$' AND "tenant_establishments"."code" <> '000'),
	CONSTRAINT "tenant_establishments_department_code_format" CHECK ("tenant_establishments"."department_code" ~ '^[0-9]{1,2}$'),
	CONSTRAINT "tenant_establishments_district_code_format" CHECK ("tenant_establishments"."district_code" ~ '^[0-9]{1,4}$'),
	CONSTRAINT "tenant_establishments_city_code_format" CHECK ("tenant_establishments"."city_code" ~ '^[0-9]{1,5}$')
);
--> statement-breakpoint
CREATE TABLE "tenant_expedition_points" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"establishment_id" uuid NOT NULL,
	"code" varchar(3) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenant_expedition_points_code_format" CHECK ("tenant_expedition_points"."code" ~ '^[0-9]{3}$' AND "tenant_expedition_points"."code" <> '000')
);
--> statement-breakpoint
CREATE TABLE "tenant_timbrados" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"number" varchar(8) NOT NULL,
	"valid_from" date NOT NULL,
	"valid_to" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenant_timbrados_number_format" CHECK ("tenant_timbrados"."number" ~ '^[0-9]{8}$' AND "tenant_timbrados"."number" <> '00000000'),
	CONSTRAINT "tenant_timbrados_valid_to_after_valid_from" CHECK ("tenant_timbrados"."valid_to" IS NULL OR "tenant_timbrados"."valid_to" >= "tenant_timbrados"."valid_from")
);
--> statement-breakpoint
CREATE INDEX "tenant_establishments_tenant_id_idx" ON "tenant_establishments" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_establishments_tenant_code_idx" ON "tenant_establishments" USING btree ("tenant_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_establishments_tenant_id_id_idx" ON "tenant_establishments" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE INDEX "tenant_expedition_points_tenant_id_idx" ON "tenant_expedition_points" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "tenant_expedition_points_establishment_id_idx" ON "tenant_expedition_points" USING btree ("establishment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_expedition_points_tenant_establishment_code_idx" ON "tenant_expedition_points" USING btree ("tenant_id","establishment_id","code");--> statement-breakpoint
CREATE INDEX "tenant_timbrados_tenant_id_idx" ON "tenant_timbrados" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_timbrados_tenant_number_idx" ON "tenant_timbrados" USING btree ("tenant_id","number");--> statement-breakpoint
ALTER TABLE "tenant_establishments" ADD CONSTRAINT "tenant_establishments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_expedition_points" ADD CONSTRAINT "tenant_expedition_points_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_expedition_points" ADD CONSTRAINT "tenant_expedition_points_tenant_establishment_fk" FOREIGN KEY ("tenant_id","establishment_id") REFERENCES "public"."tenant_establishments"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_timbrados" ADD CONSTRAINT "tenant_timbrados_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
