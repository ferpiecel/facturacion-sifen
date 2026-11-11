CREATE TABLE "received_document_field_confidences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"received_document_id" uuid NOT NULL,
	"field_name" varchar(32) NOT NULL,
	"confidence" numeric(4, 3) NOT NULL,
	"extracted_value" text,
	"corrected_value" text,
	"corrected_by" text,
	"corrected_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "received_document_field_confidences_document_field_key" UNIQUE("received_document_id","field_name"),
	CONSTRAINT "received_document_field_confidences_field_name_valid" CHECK ("received_document_field_confidences"."field_name" IN ('issuer_ruc', 'issuer_legal_name', 'issued_on', 'document_number', 'receiver_ruc', 'payment_condition', 'totals', 'items')),
	CONSTRAINT "received_document_field_confidences_confidence_range" CHECK ("received_document_field_confidences"."confidence" >= 0 AND "received_document_field_confidences"."confidence" <= 1),
	CONSTRAINT "received_document_field_confidences_correction_pair" CHECK (("received_document_field_confidences"."corrected_by" IS NULL) = ("received_document_field_confidences"."corrected_at" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "received_document_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"received_document_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"description" text,
	"product_code" text,
	"quantity" numeric(18, 8),
	"unit_of_measure" text,
	"unit_price" numeric(23, 8),
	"discount" numeric(23, 8),
	"subtotal" numeric(23, 8),
	"vat_rate" smallint,
	"taxable_base" numeric(23, 8),
	"vat_amount" numeric(23, 8),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "received_document_items_document_position_key" UNIQUE("received_document_id","position"),
	CONSTRAINT "received_document_items_position_positive" CHECK ("received_document_items"."position" >= 1),
	CONSTRAINT "received_document_items_vat_rate_valid" CHECK ("received_document_items"."vat_rate" IS NULL OR "received_document_items"."vat_rate" IN (0, 5, 10))
);
--> statement-breakpoint
ALTER TABLE "received_document_field_confidences" ADD CONSTRAINT "received_document_field_confidences_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "received_document_field_confidences" ADD CONSTRAINT "received_document_field_confidences_document_fk" FOREIGN KEY ("tenant_id","received_document_id") REFERENCES "public"."received_documents"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "received_document_items" ADD CONSTRAINT "received_document_items_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "received_document_items" ADD CONSTRAINT "received_document_items_document_fk" FOREIGN KEY ("tenant_id","received_document_id") REFERENCES "public"."received_documents"("tenant_id","id") ON DELETE no action ON UPDATE no action;
