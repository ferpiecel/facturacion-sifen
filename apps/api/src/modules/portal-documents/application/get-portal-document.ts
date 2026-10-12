import {
  buildDocumentEvents,
  parseSifenMessages,
  rejectionReasonOf,
  type DocumentEvent,
} from '../domain/document-events.js';
import { toPortalDocumentItem, type PortalDocumentItem } from './portal-document-item.js';
import type { PortalDocumentSource } from './ports/portal-document-source.port.js';

export interface PortalDocumentDetail extends PortalDocumentItem {
  environment: 'test' | 'production';
  events: DocumentEvent[];
  rejectionReason: string | null;
}

/** HU-E12-02: one document of the active tenant, or `null` (another tenant's is indistinguishable). */
export function createGetPortalDocument(deps: { source: PortalDocumentSource }) {
  return async (tenantId: string, id: string): Promise<PortalDocumentDetail | null> => {
    const row = await deps.source.findById(tenantId, id);
    if (!row) return null;
    const messages = parseSifenMessages(row.sifenMessages);
    return {
      ...toPortalDocumentItem(row),
      environment: row.environment,
      events: buildDocumentEvents({ ...row, messages }),
      rejectionReason: rejectionReasonOf(row.status, messages),
    };
  };
}
