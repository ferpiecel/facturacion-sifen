-- Manual rollback for 0027: drop the contact constraints, then the columns.
ALTER TABLE "tenant_establishments" DROP CONSTRAINT IF EXISTS "tenant_establishments_commercial_name_length";
ALTER TABLE "tenant_establishments" DROP CONSTRAINT IF EXISTS "tenant_establishments_email_format";
ALTER TABLE "tenant_establishments" DROP CONSTRAINT IF EXISTS "tenant_establishments_phone_length";
ALTER TABLE "tenant_establishments" DROP COLUMN IF EXISTS "commercial_name";
ALTER TABLE "tenant_establishments" DROP COLUMN IF EXISTS "email";
ALTER TABLE "tenant_establishments" DROP COLUMN IF EXISTS "phone";
