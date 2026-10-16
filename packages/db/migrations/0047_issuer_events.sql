CREATE TABLE "issuer_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"environment" "tenant_environment" NOT NULL,
	"kind" varchar(16) NOT NULL,
	"event_id" bigint NOT NULL,
	"document_id" uuid,
	"void_range" jsonb,
	"reason" text NOT NULL,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"signed_xml" text,
	"signed_at" timestamp with time zone,
	"batch_d_id" bigint,
	"send_attempted_at" timestamp with time zone,
	"response_code" varchar(8),
	"response_message" text,
	"sifen_protocol" varchar(16),
	"responded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "issuer_events_event_id_key" UNIQUE("tenant_id","environment","event_id"),
	CONSTRAINT "issuer_events_kind_valid" CHECK ("issuer_events"."kind" IN ('cancellation', 'voiding', 'nomination')),
	CONSTRAINT "issuer_events_status_valid" CHECK ("issuer_events"."status" IN ('pending', 'signed', 'sending', 'approved', 'rejected', 'unknown')),
	CONSTRAINT "issuer_events_event_id_range" CHECK ("issuer_events"."event_id" BETWEEN 1 AND 9999999999),
	CONSTRAINT "issuer_events_reason_length" CHECK (char_length("issuer_events"."reason") BETWEEN 5 AND 500),
	CONSTRAINT "issuer_events_subject" CHECK (("issuer_events"."kind" = 'voiding') = ("issuer_events"."void_range" IS NOT NULL) AND ("issuer_events"."kind" = 'voiding') = ("issuer_events"."document_id" IS NULL)),
	CONSTRAINT "issuer_events_signed_pair" CHECK (("issuer_events"."signed_xml" IS NULL) = ("issuer_events"."signed_at" IS NULL) AND ("issuer_events"."status" = 'pending') = ("issuer_events"."signed_xml" IS NULL)),
	CONSTRAINT "issuer_events_sent_pair" CHECK (("issuer_events"."status" IN ('pending', 'signed')) = ("issuer_events"."batch_d_id" IS NULL) AND ("issuer_events"."batch_d_id" IS NULL) = ("issuer_events"."send_attempted_at" IS NULL)),
	CONSTRAINT "issuer_events_answered_pair" CHECK (("issuer_events"."status" IN ('approved', 'rejected')) = ("issuer_events"."response_code" IS NOT NULL AND "issuer_events"."responded_at" IS NOT NULL) OR "issuer_events"."status" = 'unknown')
);
--> statement-breakpoint
ALTER TABLE "issuer_events" ADD CONSTRAINT "issuer_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issuer_events" ADD CONSTRAINT "issuer_events_tenant_document_fk" FOREIGN KEY ("tenant_id","document_id") REFERENCES "public"."documents"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "issuer_events_open_idx" ON "issuer_events" USING btree ("tenant_id","document_id","kind") WHERE "issuer_events"."document_id" IS NOT NULL AND "issuer_events"."status" <> 'rejected';--> statement-breakpoint
CREATE INDEX "issuer_events_to_send_idx" ON "issuer_events" USING btree ("tenant_id","environment","created_at") WHERE "issuer_events"."status" = 'signed';
--> statement-breakpoint
-- RLS + grants (same pattern as 0029): no DELETE, events are the history of what was sent to SIFEN.
ALTER TABLE "issuer_events" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "issuer_events" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "issuer_events" TO app_user;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "issuer_events" TO platform_admin;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "issuer_events"
  TO app_user
  USING (tenant_id = nullif(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.current_tenant', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "platform_admin_all" ON "issuer_events"
  TO platform_admin
  USING (true)
  WITH CHECK (true);
