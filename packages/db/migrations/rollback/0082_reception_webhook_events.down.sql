-- Manual rollback for 0082 (run the rollbacks of newer migrations first). Restores the
-- catalogue without the reception events. Re-adding the CHECKs fails while any endpoint still subscribes to a
-- reception event or any delivery carries one; remove those rows (or edit the endpoint filters)
-- first so the failure is deliberate and nothing is dropped silently.
ALTER TABLE "webhook_deliveries" DROP CONSTRAINT IF EXISTS "webhook_deliveries_event_type_valid";
--> statement-breakpoint
ALTER TABLE "webhook_endpoints" DROP CONSTRAINT IF EXISTS "webhook_endpoints_events_valid";
--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_event_type_valid" CHECK ("webhook_deliveries"."event_type" IN ('document.created', 'document.signed', 'document.submitted', 'document.approved', 'document.approved_with_observations', 'document.rejected', 'document.cancelled', 'document.number_voided', 'document.nominated', 'document.transmission_deadline_warning', 'document.notification.delivered', 'document.notification.failed', 'certificate.expiring'));
--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_events_valid" CHECK ("webhook_endpoints"."events" <@ ARRAY['document.created', 'document.signed', 'document.submitted', 'document.approved', 'document.approved_with_observations', 'document.rejected', 'document.cancelled', 'document.number_voided', 'document.nominated', 'document.transmission_deadline_warning', 'document.notification.delivered', 'document.notification.failed', 'certificate.expiring']::text[]);
