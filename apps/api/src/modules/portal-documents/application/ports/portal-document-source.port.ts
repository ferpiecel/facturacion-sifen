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

/** The list row plus what only the detail shows. */
export interface PortalDocumentDetailRow extends PortalDocumentRow {
  environment: 'test' | 'production';
  createdAt: Date;
  signedAt: Date | null;
  updatedAt: Date;
  /** The stored `sifen_messages` JSON, not yet validated. */
  sifenMessages: unknown;
}

/** The signed DE of a document; `signedXml` is null until it is signed. */
export interface PortalSignedXml {
  cdc: string;
  number: string;
  environment: 'test' | 'production';
  signedXml: string | null;
}

/** Tenant-scoped reads inside the tenant's RLS transaction; another tenant's data is never visible. */
export interface PortalDocumentSource {
  list(
    tenantId: string,
    filter: DocumentListFilter,
  ): Promise<{ rows: PortalDocumentRow[]; total: number }>;
  /** `null` when the id is not a document of the tenant. */
  findById(tenantId: string, id: string): Promise<PortalDocumentDetailRow | null>;
  findSignedXml(tenantId: string, id: string): Promise<PortalSignedXml | null>;
}
