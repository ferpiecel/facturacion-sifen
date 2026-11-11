-- Manual rollback for 0077 (run 0078's rollback first).
DROP TABLE IF EXISTS "received_document_items";
DROP TABLE IF EXISTS "received_document_field_confidences";
