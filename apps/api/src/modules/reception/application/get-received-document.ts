import type {
  ReceivedDocumentDetail,
  ReceivedDocumentQuery,
} from './ports/received-document-query.port.js';

/** The full read model of one document, or `null` when it does not exist for the tenant. */
export function createGetReceivedDocument(deps: { readonly query: ReceivedDocumentQuery }) {
  return (tenantId: string, id: string): Promise<ReceivedDocumentDetail | null> =>
    deps.query.find(tenantId, id);
}
