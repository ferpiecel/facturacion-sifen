import { describe, expect, it } from 'vitest';
import { RECEIVED_FIELD_NAMES } from './confidence-policy.js';
import {
  InvalidExtractionResultError,
  parseExtractionResult,
  toReceivedDocumentFields,
} from './extraction-result.js';
import { validateReceivedDocument } from './received-document-validation.js';

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

describe('parseExtractionResult totals shape', () => {
  const totals = raw().totals as Record<string, unknown>;
  const without = (key: string): Record<string, unknown> => {
    return Object.fromEntries(Object.entries(totals).filter(([name]) => name !== key));
  };

  it.each(Object.keys(totals))('rejects totals with a missing %s', (key) => {
    expect(() => parseExtractionResult(raw({ totals: without(key) }))).toThrow(
      new RegExp(`totals\\.${key}`),
    );
  });

  it.each(Object.keys(totals))('rejects totals with a null %s', (key) => {
    expect(() => parseExtractionResult(raw({ totals: { ...totals, [key]: null } }))).toThrow(
      InvalidExtractionResultError,
    );
  });

  it.each([
    ['a string', 'total'],
    ['an array', [1, 2]],
    ['a number', 5],
  ])('rejects totals given as %s', (_name, value) => {
    expect(() => parseExtractionResult(raw({ totals: value }))).toThrow(/totals/);
  });
});

describe('parseExtractionResult items shape', () => {
  it.each([
    ['null', null],
    ['a string', 'item'],
  ])('rejects an item that is %s', (_name, item) => {
    expect(() => parseExtractionResult(raw({ items: [item] }))).toThrow(/items\[0\]/);
  });

  it('turns an omitted vatRate into null', () => {
    const result = parseExtractionResult(raw({ items: [{ description: 'x' }] }));
    expect(result.items[0]?.vatRate).toBeNull();
  });

  it.each([0, 5, 10] as const)('accepts vat rate %i', (rate) => {
    const result = parseExtractionResult(raw({ items: [{ vatRate: rate }] }));
    expect(result.items[0]?.vatRate).toBe(rate);
  });
});

describe('extraction projection through validateReceivedDocument', () => {
  const withSubtotals = (subtotals: (string | null)[]): string[] => {
    const items = subtotals.map((subtotal) => ({ subtotal }));
    const fields = toReceivedDocumentFields(parseExtractionResult(raw({ items })));
    return validateReceivedDocument(fields);
  };

  it('flags items_sum_mismatch when the non-null subtotals do not add up to the total', () => {
    expect(withSubtotals(['100000', '50000'])).toContain('items_sum_mismatch');
  });

  it('accepts subtotals that add up to the total', () => {
    expect(withSubtotals(['100000', '104000'])).not.toContain('items_sum_mismatch');
  });

  it('sums only the non-null subtotals, so a null-subtotal line makes the sum fall short', () => {
    // Pins current behavior: partial coverage is judged as a mismatch.
    expect(withSubtotals([null, '100000'])).toContain('items_sum_mismatch');
    expect(withSubtotals([null, '204000'])).not.toContain('items_sum_mismatch');
  });

  it('skips the items-sum check when every subtotal is null (current behavior, pinned)', () => {
    // Pins current behavior: itemAmounts is empty, which validateTotals reads as "no items".
    expect(withSubtotals([null, null])).not.toContain('items_sum_mismatch');
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
