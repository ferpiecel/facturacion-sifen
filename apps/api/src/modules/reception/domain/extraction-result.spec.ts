import { describe, expect, it } from 'vitest';
import { RECEIVED_FIELD_NAMES } from './confidence-policy.js';
import {
  InvalidExtractionResultError,
  parseExtractionResult,
  toReceivedDocumentFields,
} from './extraction-result.js';

const confidences = Object.fromEntries(RECEIVED_FIELD_NAMES.map((n) => [n, 0.9]));

const raw = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  cdc: null,
  issuerRuc: '80012345-6',
  issuerLegalName: 'Proveedor SA',
  documentNumber: '001-001-0000123',
  issueDate: '2026-03-15',
  receiverRuc: '80099999-1',
  paymentCondition: 'cash',
  totals: {
    exempt: '0',
    exonerated: '0',
    taxable5: '0',
    taxable10: '185454.54545455',
    vat5: '0',
    vat10: '18545.45454545',
    total: '204000',
  },
  items: [
    {
      description: 'Servicio',
      productCode: null,
      quantity: '1',
      unitOfMeasure: 'UNI',
      unitPrice: '204000',
      discount: null,
      subtotal: '204000',
      vatRate: 10,
      taxableBase: '185454.54545455',
      vatAmount: '18545.45454545',
    },
  ],
  fieldConfidences: confidences,
  overallConfidence: 0.92,
  ...over,
});

describe('parseExtractionResult', () => {
  it('builds a frozen result keeping amounts as strings', () => {
    const result = parseExtractionResult(raw());
    expect(result.totals?.total).toBe('204000');
    expect(result.items[0]?.unitPrice).toBe('204000');
    expect(result.overallConfidence).toBe(0.92);
    expect(Object.isFrozen(result)).toBe(true);
  });

  it('accepts nulls for every optional header field and no items', () => {
    const result = parseExtractionResult(
      raw({
        issuerRuc: null,
        issuerLegalName: null,
        documentNumber: null,
        issueDate: null,
        receiverRuc: null,
        paymentCondition: null,
        totals: null,
        items: [],
      }),
    );
    expect(result.totals).toBeNull();
    expect(result.items).toEqual([]);
  });

  it.each([
    ['numeric amount', { totals: { ...(raw().totals as object), total: 204000 } }, /totals\.total/],
    [
      'malformed amount',
      { totals: { ...(raw().totals as object), vat10: 'abc' } },
      /totals\.vat10/,
    ],
    ['bad payment condition', { paymentCondition: 'barter' }, /paymentCondition/],
    ['non-string name', { issuerLegalName: 7 }, /issuerLegalName/],
    ['items not an array', { items: {} }, /items/],
    ['item amount as number', { items: [{ subtotal: 5 }] }, /items\[0\]\.subtotal/],
    ['bad vat rate', { items: [{ vatRate: 7 }] }, /items\[0\]\.vatRate/],
    ['overall out of range', { overallConfidence: 1.5 }, /overallConfidence/],
    ['missing overall', { overallConfidence: undefined }, /overallConfidence/],
    ['field confidence out of range', { fieldConfidences: { ...confidences, items: -1 } }, /items/],
  ])('rejects %s', (_name, over, message) => {
    expect(() => parseExtractionResult(raw(over))).toThrow(InvalidExtractionResultError);
    expect(() => parseExtractionResult(raw(over))).toThrow(message);
  });

  it('rejects a non-object', () => {
    expect(() => parseExtractionResult(null)).toThrow(InvalidExtractionResultError);
    expect(() => parseExtractionResult([])).toThrow(InvalidExtractionResultError);
  });
});

describe('toReceivedDocumentFields', () => {
  it('maps header fields and the non-null item subtotals for validation', () => {
    const fields = toReceivedDocumentFields(parseExtractionResult(raw()));
    expect(fields.issuerRuc).toBe('80012345-6');
    expect(fields.itemAmounts).toEqual(['204000']);
    expect(fields.totals?.total).toBe('204000');
  });
});
