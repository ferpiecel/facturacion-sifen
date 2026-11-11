-- Manual rollback for 0051 (RLS, grants and trigger hand-written there, then the tables).
DROP TRIGGER IF EXISTS "usage_counters_guard" ON "usage_counters";
DROP FUNCTION IF EXISTS "usage_counters_guard"();
DROP TABLE IF EXISTS "usage_counters";
DROP TABLE IF EXISTS "invoices_saas";
