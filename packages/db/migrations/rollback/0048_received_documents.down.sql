-- Manual rollback for 0048 (run 0049's rollback first). Dropping the table drops its trigger.
DROP TABLE IF EXISTS "received_documents";
DROP FUNCTION IF EXISTS "received_documents_guard"();
