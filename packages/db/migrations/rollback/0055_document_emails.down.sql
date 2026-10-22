-- Manual rollback for 0055: drops the outbox with its policies and indexes. Emails still pending are never sent and the history of sent ones is lost: export them first.
DROP TABLE IF EXISTS "document_emails";
