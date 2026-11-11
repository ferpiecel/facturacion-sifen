ALTER TABLE "plans" ADD COLUMN "audience" text DEFAULT 'direct' NOT NULL;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "monthly_price" bigint;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "overage_price" bigint;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "document_quota" integer;--> statement-breakpoint
ALTER TABLE "plans" ADD CONSTRAINT "plans_audience_valid" CHECK ("plans"."audience" IN ('direct', 'partner'));--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_terms_nonneg" CHECK (coalesce("subscriptions"."monthly_price", 0) >= 0 AND coalesce("subscriptions"."overage_price", 0) >= 0 AND coalesce("subscriptions"."document_quota", 0) >= 0);--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_snapshot_complete" CHECK (("subscriptions"."monthly_price" IS NULL AND "subscriptions"."overage_price" IS NULL AND "subscriptions"."document_quota" IS NULL) OR ("subscriptions"."monthly_price" IS NOT NULL AND "subscriptions"."overage_price" IS NOT NULL AND "subscriptions"."document_quota" IS NOT NULL));
--> statement-breakpoint
-- Once a subscription carries its price snapshot, the terms never change (a later price change
-- applies to a new subscription). Setting them while still null is allowed.
CREATE FUNCTION "subscriptions_snapshot_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.monthly_price IS NOT NULL AND (
    NEW.monthly_price IS DISTINCT FROM OLD.monthly_price
    OR NEW.overage_price IS DISTINCT FROM OLD.overage_price
    OR NEW.document_quota IS DISTINCT FROM OLD.document_quota
  ) THEN
    RAISE EXCEPTION 'subscription price snapshot is immutable';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "subscriptions_snapshot_guard" BEFORE UPDATE ON "subscriptions"
  FOR EACH ROW EXECUTE FUNCTION "subscriptions_snapshot_guard"();
