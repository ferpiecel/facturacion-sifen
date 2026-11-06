-- Manual rollback for 0050 (run 0051's rollback first).
DROP TABLE IF EXISTS "received_document_items";
DROP TABLE IF EXISTS "received_document_field_confidences";
