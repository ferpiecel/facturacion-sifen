import { describe, expect, it } from 'vitest';
import { createReceivedDocument } from '../domain/received-document.js';
import {
  InvalidReceivedDocumentQueryError,
  MAX_LIST_LIMIT,
  createListReceivedDocuments,
} from './list-received-documents.js';
import type {
  ReceivedDocumentListQuery,
  ReceivedDocumentQuery,
  ReceivedDocumentSummary,
} from './ports/received-document-query.port.js';

const TENANT = '11111111-1111-4111-8111-111111111111';

const summary = (n: number): ReceivedDocumentSummary => ({
  document: createReceivedDocument({
    id: `00000000-0000-4000-8000-00000000000${String(n)}`,
    tenantId: TENANT,
    source: 'sifen_xml',
    isOwnReceiver: true,
  }),
  header: {
    documentType: null,
    cdc: null,
    establishmentCode: null,
    expeditionPointCode: null,
    documentNumber: null,
    issuerRucBase: null,
    issuerRucDv: null,
    issuerLegalName: null,
    issuedAt: null,
    currency: 'PYG',
    totalVat: null,
    totalAmount: null,
    confirmedBy: null,
  },
  hasArtifact: false,
  createdAt: new Date(),
  updatedAt: new Date(),
  createdAtKey: `2026-03-10 12:00:00.12345${String(n)}+00`,
});

function setup(rows: ReceivedDocumentSummary[] = []) {
  const calls: ReceivedDocumentListQuery[] = [];
  const query: ReceivedDocumentQuery = {
    list: (_tenant, q) => {
      calls.push(q);
      return Promise.resolve(rows);
    },
    find: () => Promise.resolve(null),
  };
  return { list: createListReceivedDocuments({ query }), calls };
}

describe('createListReceivedDocuments', () => {
  it('applies the default limit and no filters', async () => {
    const { list, calls } = setup();
    await list(TENANT, {});
    expect(calls).toEqual([{ limit: 50 }]);
  });

  it('translates every filter into the store query', async () => {
    const { list, calls } = setup();
    await list(TENANT, {
      limit: '10',
      status: 'confirmed',
      source: 'pdf',
      issuer_ruc: '80000001-8',
      issued_from: '2026-03-01',
      issued_to: '2026-03-31',
      is_own_receiver: 'false',
      cdc_prefix: '0180',
      updated_since: '2026-03-01T00:00:00Z',
    });
    expect(calls[0]).toEqual({
      limit: 10,
      status: 'confirmed',
      source: 'pdf',
      issuerRucBase: '80000001',
      issuedFrom: new Date('2026-03-01Z'),
      issuedBefore: new Date('2026-04-01Z'),
      isOwnReceiver: false,
      cdcPrefix: '0180',
      updatedSince: new Date('2026-03-01T00:00:00Z'),
    });
  });

  it('issues a cursor only when the store returned more than the limit, and it round trips', async () => {
    const { list, calls } = setup([summary(1), summary(2), summary(3)]);
    const page = await list(TENANT, { limit: '2' });

    expect(page.items).toHaveLength(2);
    expect(calls[0].limit).toBe(2);
    expect(page.nextCursor).not.toBeNull();

    await list(TENANT, { cursor: page.nextCursor ?? '' });
    expect(calls[1].after).toEqual({
      createdAt: '2026-03-10 12:00:00.123452+00',
      id: '00000000-0000-4000-8000-000000000002',
    });
    expect((await setup([summary(1)]).list(TENANT, {})).nextCursor).toBeNull();
  });

  it.each([
    ['limit', '0'],
    ['limit', String(MAX_LIST_LIMIT + 1)],
    ['limit', '1.5'],
    ['cursor', 'garbage'],
    ['cursor', Buffer.from('["2026-03-10; DROP","x"]').toString('base64url')],
    ['status', 'bogus'],
    ['source', 'bogus'],
    ['issuer_ruc', 'abc'],
    ['issued_from', '2026-02-31'],
    ['issued_to', 'tomorrow'],
    ['is_own_receiver', 'yes'],
    ['cdc_prefix', '12a'],
    ['updated_since', '2026-03-01'],
    ['status', ['confirmed', 'needs_review']],
  ])('rejects %s=%s', async (field, value) => {
    const { list, calls } = setup();
    await expect(list(TENANT, { [field]: value })).rejects.toBeInstanceOf(
      InvalidReceivedDocumentQueryError,
    );
    expect(calls).toEqual([]);
  });
});
