-- Manual rollback for 0079 (independent of the table rollbacks, which drop their own triggers).
DROP TRIGGER IF EXISTS "received_document_field_confidences_guard" ON "received_document_field_confidences";
DROP TRIGGER IF EXISTS "received_document_items_guard" ON "received_document_items";
DROP FUNCTION IF EXISTS "received_document_field_confidences_guard"();
DROP FUNCTION IF EXISTS "received_document_items_guard"();
