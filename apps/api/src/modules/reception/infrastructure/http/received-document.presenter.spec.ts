import { describe, expect, it } from 'vitest';
import type { ReceivedDocumentDetail } from '../../application/ports/received-document-query.port.js';
import { createReceivedDocument } from '../../domain/received-document.js';
import { presentReceivedDocumentDetail } from './received-document.presenter.js';

describe('presentReceivedDocumentDetail', () => {
  /** A header whose every field is null unless overridden. */
  const header = (overrides: object = {}) =>
    new Proxy(overrides, {
      get: (target, key) => (key in target ? (target as Record<PropertyKey, unknown>)[key] : null),
    }) as ReceivedDocumentDetail['header'];
  const base = (overrides: object = {}): ReceivedDocumentDetail => ({
    document: createReceivedDocument({
      id: '00000000-0000-4000-8000-000000000001',
      tenantId: 't',
      source: 'sifen_xml',
      isOwnReceiver: true,
    }),
    header: header(overrides),
    items: [],
    confidences: [],
    artifact: null,
    createdAt: new Date('2026-03-10T12:00:00Z'),
    updatedAt: new Date('2026-03-10T12:00:00Z'),
  });

  it('trims decimal padding and keeps integers intact', () => {
    const out = presentReceivedDocumentDetail(
      base({
        totalAmount: '100.00000000',
        totalVat: '10.50000000',
        exchangeRate: '7500',
        totalPyg: '0.00000000',
      }),
    );
    expect(out.totals).toMatchObject({ total_amount: '100', total_vat: '10.5', total_pyg: '0' });
    expect(out.exchange_rate).toBe('7500');
  });

  it('has no artifact link and no ruc when nothing was extracted', () => {
    const out = presentReceivedDocumentDetail(base());
    expect(out.artifact).toBeNull();
    expect(out.artifact_url).toBeNull();
    expect(out.issuer.ruc).toBeNull();
    expect(out.document_number).toBeNull();
  });
});
