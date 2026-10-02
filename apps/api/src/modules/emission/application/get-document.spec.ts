import { describe, expect, it, vi } from 'vitest';
import { createGetDocument } from './get-document.js';
import type { DocumentReader, DocumentView } from './ports/document-reader.port.js';

const VIEW: DocumentView = {
  documentId: 'd1',
  cdc: '1'.repeat(44),
  number: '001-002-0000007',
  status: 'accepted',
  environment: 'test',
  issuedAt: new Date('2026-05-01T12:00:00.000Z'),
  totalAmount: '110000.00000000',
  currency: 'PYG',
  receiverRuc: '80069563-1',
};

function readerWith(view: DocumentView | null) {
  const findById = vi.fn<DocumentReader['findById']>(() => Promise.resolve(view));
  const findByCdc = vi.fn<DocumentReader['findByCdc']>(() => Promise.resolve(view));
  const reader: DocumentReader = { findById, findByCdc };
  return { reader, findById, findByCdc };
}

/** Spec: HU-E5-07. */
describe('getDocument', () => {
  it('shapes the stored document without the payload; SIFEN fields and urls are null until they exist', async () => {
    const result = await createGetDocument({ reader: readerWith(VIEW).reader })('t1', { id: 'd1' });

    expect(result).toEqual({
      document_id: 'd1',
      cdc: '1'.repeat(44),
      number: '001-002-0000007',
      status: 'accepted',
      environment: 'test',
      issued_at: '2026-05-01T12:00:00.000Z',
      totals: { amount: '110000', currency: 'PYG' },
      receiver: { ruc: '80069563-1' },
      sifen: null,
      urls: { xml: null, kude: null },
    });
  });

  it('keeps decimals and omits the receiver when there is none', async () => {
    const result = await createGetDocument({
      reader: readerWith({ ...VIEW, totalAmount: '10.50000000', receiverRuc: null }).reader,
    })('t1', { cdc: VIEW.cdc });

    expect(result?.totals.amount).toBe('10.5');
    expect(result?.receiver).toBeNull();
  });

  it('looks up by id or by cdc inside the given tenant, and returns null when absent', async () => {
    const { reader, findById, findByCdc } = readerWith(null);
    const get = createGetDocument({ reader });

    expect(await get('t1', { id: 'd1' })).toBeNull();
    expect(await get('t1', { cdc: VIEW.cdc })).toBeNull();
    expect(findById).toHaveBeenCalledWith('t1', 'd1');
    expect(findByCdc).toHaveBeenCalledWith('t1', VIEW.cdc);
  });
});
