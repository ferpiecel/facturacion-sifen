-- Manual rollback for 0047: drops the table with its policies and indexes. The events it holds (what was
-- signed and sent to SIFEN) are lost: export them first. Roll back 0048 (the guards) first.
DROP TABLE IF EXISTS "issuer_events";
