-- Manual rollback for 0060: restores the previous event type lists. Delete endpoints' subscriptions and queued deliveries of `certificate.expiring` first or the constraints fail to re-add.
DELETE FROM "webhook_deliveries" WHERE "event_type" = 'certificate.expiring';
UPDATE "webhook_endpoints" SET "events" = array_remove("events", 'certificate.expiring');
ALTER TABLE "webhook_deliveries" DROP CONSTRAINT "webhook_deliveries_event_type_valid";
ALTER TABLE "webhook_endpoints" DROP CONSTRAINT "webhook_endpoints_events_valid";
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_event_type_valid" CHECK ("webhook_deliveries"."event_type" IN ('document.created', 'document.signed', 'document.submitted', 'document.approved', 'document.approved_with_observations', 'document.rejected', 'document.cancelled', 'document.number_voided', 'document.transmission_deadline_warning', 'document.notification.delivered', 'document.notification.failed'));
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_events_valid" CHECK ("webhook_endpoints"."events" <@ ARRAY['document.created', 'document.signed', 'document.submitted', 'document.approved', 'document.approved_with_observations', 'document.rejected', 'document.cancelled', 'document.number_voided', 'document.transmission_deadline_warning', 'document.notification.delivered', 'document.notification.failed']::text[]);
