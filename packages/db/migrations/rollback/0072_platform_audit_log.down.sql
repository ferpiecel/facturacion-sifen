-- Manual rollback for 0072: drops the platform_admin audit trail and its triggers (the records are lost).
DROP TABLE "platform_audit_log";--> statement-breakpoint
DROP FUNCTION "platform_audit_log_before_insert"();--> statement-breakpoint
DROP FUNCTION "platform_audit_log_reject_mutation"();--> statement-breakpoint
DROP FUNCTION "platform_audit_log_compute_hash"(uuid, bigint, timestamptz, text, text, jsonb, integer, text);
