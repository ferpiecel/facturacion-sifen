import type { DocumentListFilter } from '../domain/list-query.js';
import { toPortalDocumentItem, type PortalDocumentItem } from './portal-document-item.js';
import type { PortalDocumentSource } from './ports/portal-document-source.port.js';

export interface PortalDocumentPage {
  items: PortalDocumentItem[];
  page: number;
  pageSize: number;
  total: number;
}

/** HU-E12-01: one page of the active tenant's documents, newest first. */
export function createListPortalDocuments(deps: { source: Pick<PortalDocumentSource, 'list'> }) {
  return async (tenantId: string, filter: DocumentListFilter): Promise<PortalDocumentPage> => {
    const { rows, total } = await deps.source.list(tenantId, filter);
    return {
      items: rows.map(toPortalDocumentItem),
      page: filter.page,
      pageSize: filter.pageSize,
      total,
    };
  };
}
