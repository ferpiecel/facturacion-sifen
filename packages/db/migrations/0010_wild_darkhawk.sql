CREATE TYPE "public"."tenant_environment" AS ENUM('test', 'production');--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "environment" "tenant_environment" DEFAULT 'test' NOT NULL;