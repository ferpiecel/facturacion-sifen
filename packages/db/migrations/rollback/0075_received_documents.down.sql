-- Manual rollback for 0075 (run 0076's rollback first). Dropping the table drops its trigger.
DROP TABLE IF EXISTS "received_documents";
DROP FUNCTION IF EXISTS "received_documents_guard"();
