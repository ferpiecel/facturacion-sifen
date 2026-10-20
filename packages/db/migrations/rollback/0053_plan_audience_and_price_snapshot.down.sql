-- Manual rollback for 0053.
ALTER TABLE "subscriptions" DROP CONSTRAINT IF EXISTS "subscriptions_terms_nonneg";
ALTER TABLE "plans" DROP CONSTRAINT IF EXISTS "plans_audience_valid";
ALTER TABLE "subscriptions" DROP COLUMN IF EXISTS "document_quota";
ALTER TABLE "subscriptions" DROP COLUMN IF EXISTS "overage_price";
ALTER TABLE "subscriptions" DROP COLUMN IF EXISTS "monthly_price";
ALTER TABLE "plans" DROP COLUMN IF EXISTS "audience";
