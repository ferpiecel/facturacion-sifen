import type { DocumentListFilter } from '../../domain/list-query.js';

/** One document as the portal list shows it; the amount is the stored numeric text. */
export interface PortalDocumentRow {
  id: string;
  cdc: string;
  /** SIFEN `iTiDE`. */
  documentType: number;
  /** `est-point-number`, e.g. `001-001-0004518`. */
  number: string;
  issuedAt: Date;
  receiverName: string;
  receiverRuc: string | null;
  totalAmount: string;
  currency: string;
  status: string;
}

/** Tenant-scoped reads inside the tenant's RLS transaction; another tenant's data is never visible. */
export interface PortalDocumentSource {
  list(
    tenantId: string,
    filter: DocumentListFilter,
  ): Promise<{ rows: PortalDocumentRow[]; total: number }>;
}
