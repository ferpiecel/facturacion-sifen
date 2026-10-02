CREATE TABLE "webhook_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"endpoint_id" uuid NOT NULL,
	"event_id" varchar(68) NOT NULL,
	"event_type" varchar(48) NOT NULL,
	"payload" jsonb NOT NULL,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"first_attempt_at" timestamp with time zone,
	"next_attempt_at" timestamp with time zone,
	"last_attempt_at" timestamp with time zone,
	"last_status_code" smallint,
	"last_error" varchar(500),
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "webhook_deliveries_endpoint_event_key" UNIQUE("endpoint_id","event_id"),
	CONSTRAINT "webhook_deliveries_status_valid" CHECK ("webhook_deliveries"."status" IN ('pending', 'failed', 'delivered', 'dead')),
	CONSTRAINT "webhook_deliveries_event_type_valid" CHECK ("webhook_deliveries"."event_type" IN ('document.created', 'document.signed', 'document.submitted', 'document.approved', 'document.approved_with_observations', 'document.rejected', 'document.cancelled', 'document.number_voided', 'document.transmission_deadline_warning', 'document.notification.delivered', 'document.notification.failed')),
	CONSTRAINT "webhook_deliveries_next_attempt_pair" CHECK (("webhook_deliveries"."status" IN ('pending', 'failed')) = ("webhook_deliveries"."next_attempt_at" IS NOT NULL)),
	CONSTRAINT "webhook_deliveries_delivered_pair" CHECK (("webhook_deliveries"."status" = 'delivered') = ("webhook_deliveries"."delivered_at" IS NOT NULL)),
	CONSTRAINT "webhook_deliveries_attempts_nonneg" CHECK ("webhook_deliveries"."attempt_count" >= 0)
);
--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_tenant_endpoint_fk" FOREIGN KEY ("tenant_id","endpoint_id") REFERENCES "public"."webhook_endpoints"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "webhook_deliveries_due_idx" ON "webhook_deliveries" USING btree ("next_attempt_at") WHERE "webhook_deliveries"."status" IN ('pending', 'failed');
--> statement-breakpoint
-- A delivery's identity and payload are frozen (retries sign the same event); it only moves
-- forward, except that the DLQ (dead) can be replayed back to pending.
CREATE FUNCTION "webhook_deliveries_guard"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.endpoint_id IS DISTINCT FROM OLD.endpoint_id
    OR NEW.event_id IS DISTINCT FROM OLD.event_id
    OR NEW.event_type IS DISTINCT FROM OLD.event_type
    OR NEW.payload IS DISTINCT FROM OLD.payload
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'webhook_deliveries: identity and payload columns are immutable';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
    (OLD.status IN ('pending', 'failed') AND NEW.status IN ('failed', 'delivered', 'dead'))
    OR (OLD.status = 'dead' AND NEW.status = 'pending')
  ) THEN
    RAISE EXCEPTION 'webhook_deliveries: invalid status transition % -> %', OLD.status, NEW.status;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "webhook_deliveries_guard" BEFORE UPDATE ON "webhook_deliveries"
FOR EACH ROW EXECUTE FUNCTION "webhook_deliveries_guard"();
--> statement-breakpoint
-- RLS + grants (same pattern as 0022): the outbox and the dispatcher run as app_user inside a
-- tenant transaction; no DELETE, deliveries are the history.
ALTER TABLE "webhook_deliveries" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "webhook_deliveries" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "webhook_deliveries" TO app_user;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "webhook_deliveries" TO platform_admin;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "webhook_deliveries"
  TO app_user
  USING (tenant_id = nullif(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.current_tenant', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "platform_admin_all" ON "webhook_deliveries"
  TO platform_admin
  USING (true)
  WITH CHECK (true);
