/**
 * Webhook events produced by received-document transitions (ADR-0028). The database CHECK lists and
 * the webhooks event catalogue carry the same four names (parity specs in packages/db and webhooks).
 */
export const RECEPTION_EVENT_TYPES = [
  'reception.document.confirmed',
  'reception.document.needs_review',
  'reception.document.extraction_failed',
  'reception.document.updated',
] as const;

export type ReceptionEventType = (typeof RECEPTION_EVENT_TYPES)[number];

/**
 * Who caused a change; carried by `reception.document.updated` so an ERP can recognise the echo of
 * its own write (same `api_key` id and the `version` it just wrote).
 */
export type ReceptionActor =
  | { readonly kind: 'api_key'; readonly id: string }
  | { readonly kind: 'portal' }
  | { readonly kind: 'system' };
