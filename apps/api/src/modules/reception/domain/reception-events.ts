/**
 * Webhook events produced by received-document transitions (ADR-0023). The database CHECK lists
 * and the webhooks event catalogue are aligned with this list in a later task (R4.5).
 */
export const RECEPTION_EVENT_TYPES = [
  'reception.document.confirmed',
  'reception.document.needs_review',
  'reception.document.extraction_failed',
  'reception.document.updated',
] as const;

export type ReceptionEventType = (typeof RECEPTION_EVENT_TYPES)[number];
