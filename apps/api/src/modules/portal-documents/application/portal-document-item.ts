import { hasObservations, trimDecimals } from '../domain/portal-document.js';
import { portalDocumentType, type PortalDocumentType } from '../domain/document-type.js';
import type { PortalDocumentRow } from './ports/portal-document-source.port.js';

export interface PortalDocumentItem {
  id: string;
  cdc: string;
  /** `null` for a SIFEN type the portal has no code for. */
  type: PortalDocumentType | null;
  number: string;
  issuedAt: string;
  receiverName: string;
  receiverRuc: string | null;
  total: string;
  currency: string;
  status: string;
  hasObservations: boolean;
}

export function toPortalDocumentItem(row: PortalDocumentRow): PortalDocumentItem {
  return {
    id: row.id,
    cdc: row.cdc,
    type: portalDocumentType(row.documentType),
    number: row.number,
    issuedAt: row.issuedAt.toISOString(),
    receiverName: row.receiverName,
    receiverRuc: row.receiverRuc,
    total: trimDecimals(row.totalAmount),
    currency: row.currency,
    status: row.status,
    hasObservations: hasObservations(row.status),
  };
}
