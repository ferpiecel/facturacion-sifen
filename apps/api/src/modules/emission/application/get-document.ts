import type { DocumentReader } from './ports/document-reader.port.js';

export interface DocumentResponse {
  document_id: string;
  cdc: string;
  number: string;
  status: string;
  environment: 'test' | 'production';
  issued_at: string;
  totals: { amount: string; currency: string };
  receiver: { ruc: string } | null;
  /** SIFEN's answer; null until transmission stores it (HU-E6). */
  sifen: { code: string; message: string } | null;
  /** Null until the XML and KuDE endpoints exist, rather than dead links. */
  urls: { xml: string | null; kude: string | null };
}

/** `110000.00000000` -> `110000`, `10.50000000` -> `10.5`. */
function trimDecimals(amount: string): string {
  return amount.includes('.') ? amount.replace(/\.?0+$/, '') : amount;
}

/** HU-E5-07: one document of the tenant by id or CDC, or `null`. */
export function createGetDocument(deps: { reader: DocumentReader }) {
  return async (
    tenantId: string,
    by: { id: string } | { cdc: string },
  ): Promise<DocumentResponse | null> => {
    const view =
      'id' in by
        ? await deps.reader.findById(tenantId, by.id)
        : await deps.reader.findByCdc(tenantId, by.cdc);
    if (!view) return null;
    return {
      document_id: view.documentId,
      cdc: view.cdc,
      number: view.number,
      status: view.status,
      environment: view.environment,
      issued_at: view.issuedAt.toISOString(),
      totals: { amount: trimDecimals(view.totalAmount), currency: view.currency },
      receiver: view.receiverRuc ? { ruc: view.receiverRuc } : null,
      sifen: null,
      urls: { xml: null, kude: null },
    };
  };
}
