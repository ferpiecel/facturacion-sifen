ALTER TABLE "tenant_establishments" ALTER COLUMN "district_code" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "tenant_establishments" ADD COLUMN "house_number" varchar(6) NOT NULL;--> statement-breakpoint
ALTER TABLE "tenant_establishments" ADD COLUMN "address_complement_1" varchar(255);--> statement-breakpoint
ALTER TABLE "tenant_establishments" ADD COLUMN "address_complement_2" varchar(255);--> statement-breakpoint
ALTER TABLE "tenant_establishments" ADD COLUMN "district_description" varchar(30);--> statement-breakpoint
ALTER TABLE "tenant_establishments" ADD COLUMN "city_description" varchar(30) NOT NULL;--> statement-breakpoint
ALTER TABLE "tenant_establishments" ADD CONSTRAINT "tenant_establishments_district_code_description_pairing" CHECK (("tenant_establishments"."district_code" IS NULL) = ("tenant_establishments"."district_description" IS NULL));