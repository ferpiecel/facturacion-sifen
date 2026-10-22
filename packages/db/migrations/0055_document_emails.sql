CREATE TABLE "document_emails" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"recipient" varchar(254),
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"last_attempt_at" timestamp with time zone,
	"last_error" varchar(64),
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_emails_document_key" UNIQUE("tenant_id","document_id"),
	CONSTRAINT "document_emails_status_valid" CHECK ("document_emails"."status" IN ('pending', 'failed', 'sent', 'dead', 'skipped')),
	CONSTRAINT "document_emails_next_attempt_pair" CHECK (("document_emails"."status" IN ('pending', 'failed')) = ("document_emails"."next_attempt_at" IS NOT NULL)),
	CONSTRAINT "document_emails_sent_pair" CHECK (("document_emails"."status" = 'sent') = ("document_emails"."sent_at" IS NOT NULL)),
	CONSTRAINT "document_emails_attempts_nonneg" CHECK ("document_emails"."attempt_count" >= 0),
	CONSTRAINT "document_emails_recipient_format" CHECK ("document_emails"."recipient" IS NULL OR (position('@' in "document_emails"."recipient") > 1 AND "document_emails"."recipient" !~ '[[:space:]]')),
	CONSTRAINT "document_emails_skipped_pair" CHECK (("document_emails"."status" = 'skipped') = ("document_emails"."recipient" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "document_emails" ADD CONSTRAINT "document_emails_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_emails" ADD CONSTRAINT "document_emails_tenant_document_fk" FOREIGN KEY ("tenant_id","document_id") REFERENCES "public"."documents"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "document_emails_due_idx" ON "document_emails" USING btree ("next_attempt_at") WHERE "document_emails"."status" IN ('pending', 'failed');
--> statement-breakpoint
-- RLS + grants (same pattern as 0047): no DELETE, the outbox is the history of what was sent.
ALTER TABLE "document_emails" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "document_emails" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "document_emails" TO app_user;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "document_emails" TO platform_admin;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "document_emails"
  AS PERMISSIVE FOR ALL
  TO app_user
  USING (tenant_id = nullif(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.current_tenant', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "platform_admin_all" ON "document_emails"
  TO platform_admin
  USING (true)
  WITH CHECK (true);
