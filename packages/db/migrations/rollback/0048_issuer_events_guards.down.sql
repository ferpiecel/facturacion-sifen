-- Manual rollback for 0048: drops the guard triggers and their functions (the table stays, unguarded).
DROP TRIGGER IF EXISTS "issuer_events_guard" ON "issuer_events";
DROP TRIGGER IF EXISTS "issuer_events_insert_guard" ON "issuer_events";
DROP FUNCTION IF EXISTS "issuer_events_guard"();
DROP FUNCTION IF EXISTS "issuer_events_insert_guard"();
