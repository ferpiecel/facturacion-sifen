/** The lifecycle states a document can be in; mirrors `DOCUMENT_STATUSES` of `@sifen/db` (checked by a spec). */
export const PORTAL_DOCUMENT_STATUSES = [
  'accepted',
  'signed',
  'queued',
  'submitted',
  'approved',
  'approved_with_observations',
  'rejected',
  'corrected',
  'number_voided',
  'cancelled',
] as const;

export function isPortalDocumentStatus(value: string): boolean {
  return (PORTAL_DOCUMENT_STATUSES as readonly string[]).includes(value);
}
