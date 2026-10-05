-- Manual rollback for 0033: drop the 'system' audit actor type. Fails while audit_log rows use it
-- (the cast below cannot map them), and the rows are append-only, so archive them first.
ALTER TYPE "public"."audit_actor_type" RENAME TO "audit_actor_type_old";
CREATE TYPE "public"."audit_actor_type" AS ENUM('api_key', 'user', 'operator');
ALTER TABLE "audit_log" ALTER COLUMN "actor_type" TYPE "public"."audit_actor_type" USING "actor_type"::text::"public"."audit_actor_type";
DROP TYPE "public"."audit_actor_type_old";
