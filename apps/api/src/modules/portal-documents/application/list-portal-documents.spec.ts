import { describe, expect, it } from 'vitest';
import { createListPortalDocuments } from './list-portal-documents.js';
import type { PortalDocumentRow } from './ports/portal-document-source.port.js';

const ROW: PortalDocumentRow = {
  id: '11111111-1111-4111-8111-111111111111',
  cdc: '01800695631001001000451812026010111234567891',
  documentType: 1,
  number: '001-001-0004518',
  issuedAt: new Date('2026-01-01T12:00:00Z'),
  receiverName: 'Cliente SA',
  receiverRuc: null,
  totalAmount: '110000.00000000',
  currency: 'PYG',
  status: 'approved_with_observations',
};

describe('createListPortalDocuments (HU-E12-01)', () => {
  it('maps rows to the portal item and passes the tenant and filter to the source', async () => {
    const calls: unknown[] = [];
    const list = createListPortalDocuments({
      source: {
        list: (tenantId, filter) => {
          calls.push([tenantId, filter]);
          return Promise.resolve({ rows: [ROW], total: 41 });
        },
      },
    });

    const result = await list('tenant-1', { page: 3, pageSize: 20 });

    expect(calls).toEqual([['tenant-1', { page: 3, pageSize: 20 }]]);
    expect(result).toEqual({
      items: [
        {
          id: ROW.id,
          cdc: ROW.cdc,
          type: 'FE',
          number: '001-001-0004518',
          issuedAt: '2026-01-01T12:00:00.000Z',
          receiverName: 'Cliente SA',
          receiverRuc: null,
          total: '110000',
          currency: 'PYG',
          status: 'approved_with_observations',
          hasObservations: true,
        },
      ],
      page: 3,
      pageSize: 20,
      total: 41,
    });
  });
});
