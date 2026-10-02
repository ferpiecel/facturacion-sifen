/** A stored document as the query side exposes it (never the raw payload). */
export interface DocumentView {
  documentId: string;
  cdc: string;
  /** `est-point-number`, e.g. `001-002-0000007`. */
  number: string;
  status: string;
  environment: 'test' | 'production';
  issuedAt: Date;
  /** Numeric column as stored, e.g. `110000.00000000`. */
  totalAmount: string;
  currency: string;
  receiverRuc: string | null;
}

/** Tenant-scoped reads: a document of another tenant is indistinguishable from a missing one. */
export interface DocumentReader {
  findById(tenantId: string, id: string): Promise<DocumentView | null>;
  findByCdc(tenantId: string, cdc: string): Promise<DocumentView | null>;
}
