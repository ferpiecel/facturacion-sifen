CREATE TABLE "tenant_document_sequences" (
	"tenant_id" uuid NOT NULL,
	"environment" varchar(16) NOT NULL,
	"timbrado_id" uuid NOT NULL,
	"establishment_id" uuid NOT NULL,
	"expedition_point_id" uuid NOT NULL,
	"document_type" smallint NOT NULL,
	"last_number" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "tenant_document_sequences_pkey" PRIMARY KEY("tenant_id","environment","timbrado_id","establishment_id","expedition_point_id","document_type"),
	CONSTRAINT "tenant_document_sequences_environment_valid" CHECK ("tenant_document_sequences"."environment" IN ('test', 'production')),
	CONSTRAINT "tenant_document_sequences_last_number_range" CHECK ("tenant_document_sequences"."last_number" BETWEEN 0 AND 9999999)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_expedition_points_tenant_establishment_id_idx" ON "tenant_expedition_points" USING btree ("tenant_id","establishment_id","id");
--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_timbrados_tenant_id_id_idx" ON "tenant_timbrados" USING btree ("tenant_id","id");
--> statement-breakpoint
ALTER TABLE "tenant_document_sequences" ADD CONSTRAINT "tenant_document_sequences_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "tenant_document_sequences" ADD CONSTRAINT "tenant_document_sequences_tenant_timbrado_fk" FOREIGN KEY ("tenant_id","timbrado_id") REFERENCES "public"."tenant_timbrados"("tenant_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "tenant_document_sequences" ADD CONSTRAINT "tenant_document_sequences_tenant_point_fk" FOREIGN KEY ("tenant_id","establishment_id","expedition_point_id") REFERENCES "public"."tenant_expedition_points"("tenant_id","establishment_id","id") ON DELETE no action ON UPDATE no action;
