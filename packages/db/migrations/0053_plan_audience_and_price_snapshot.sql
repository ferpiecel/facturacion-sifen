ALTER TABLE "plans" ADD COLUMN "audience" text DEFAULT 'direct' NOT NULL;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "monthly_price" bigint;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "overage_price" bigint;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "document_quota" integer;--> statement-breakpoint
ALTER TABLE "plans" ADD CONSTRAINT "plans_audience_valid" CHECK ("plans"."audience" IN ('direct', 'partner'));--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_terms_nonneg" CHECK (coalesce("subscriptions"."monthly_price", 0) >= 0 AND coalesce("subscriptions"."overage_price", 0) >= 0 AND coalesce("subscriptions"."document_quota", 0) >= 0);