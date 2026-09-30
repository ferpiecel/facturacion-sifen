CREATE TYPE "public"."audit_actor_type" AS ENUM('api_key', 'user', 'operator');--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_type" "audit_actor_type" NOT NULL,
	"actor_id" varchar(255) NOT NULL,
	"action" varchar(100) NOT NULL,
	"entity_type" varchar(100) NOT NULL,
	"entity_id" varchar(255) NOT NULL,
	"before" jsonb,
	"after" jsonb,
	CONSTRAINT "audit_log_action_not_blank" CHECK (btrim("audit_log"."action") <> ''),
	CONSTRAINT "audit_log_entity_id_not_blank" CHECK (btrim("audit_log"."entity_id") <> '')
);
--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_log_tenant_occurred_at_idx" ON "audit_log" USING btree ("tenant_id","occurred_at");