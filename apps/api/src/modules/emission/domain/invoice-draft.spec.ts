import { describe, expect, it } from 'vitest';
import { validateInvoiceDraft, type InvoiceDraft } from './invoice-draft.js';

const named = { kind: 'named', isPublicEntity: false } as const;

function draft(overrides: Partial<InvoiceDraft> = {}): InvoiceDraft {
  return {
    receiver: named,
    operationType: 'B2B',
    items: [{ quantity: 1, unitPrice: 110_000, vatRate: 10 }],
    roundingPyg: 0,
    location: { departmentCode: 1 },
    ...overrides,
  };
}

const rules = (d: InvoiceDraft, config = {}) => validateInvoiceDraft(d, config).map((e) => e.rule);

describe('validateInvoiceDraft', () => {
  it('accepts a valid draft', () => {
    expect(validateInvoiceDraft(draft(), {})).toEqual([]);
  });

  describe('unnamed receiver (D208c / 1321, NT 024)', () => {
    const unnamed = (price: number, rounding = 0) =>
      draft({
        receiver: { kind: 'unnamed' },
        operationType: 'B2C',
        items: [{ quantity: 1, unitPrice: price, vatRate: 10 }],
        roundingPyg: rounding,
      });

    it('allows just below 7,000,000', () => {
      expect(validateInvoiceDraft(unnamed(6_999_950), {})).toEqual([]);
    });

    it('rejects exactly 7,000,000 with SIFEN code 1321', () => {
      expect(validateInvoiceDraft(unnamed(7_000_000), {})).toEqual([
        expect.objectContaining({
          field: 'receiver',
          rule: 'unnamed-receiver-over-threshold',
          sifenCode: '1321',
        }),
      ]);
    });

    it('uses the total after rounding', () => {
      expect(rules(unnamed(7_000_040, 40))).toContain('unnamed-receiver-over-threshold');
      expect(rules(unnamed(7_000_040, 40), { unnamedThresholdPyg: 7_000_001 })).toEqual([]);
    });

    it('honours a configured threshold', () => {
      expect(rules(unnamed(1_000_000), { unnamedThresholdPyg: 1_000_000 })).toEqual([
        'unnamed-receiver-over-threshold',
      ]);
      expect(rules(unnamed(7_500_000), { unnamedThresholdPyg: 10_000_000 })).toEqual([]);
    });
  });

  describe('public entity receiver (D202b / 1332, NT 020)', () => {
    const oee = { kind: 'named', isPublicEntity: true } as const;

    it('requires B2G', () => {
      expect(validateInvoiceDraft(draft({ receiver: oee, operationType: 'B2B' }), {})).toEqual([
        expect.objectContaining({
          field: 'operationType',
          rule: 'public-entity-requires-b2g',
          sifenCode: '1332',
        }),
      ]);
      expect(validateInvoiceDraft(draft({ receiver: oee, operationType: 'B2G' }), {})).toEqual([]);
    });
  });

  describe('PYG amounts and 50 Gs rounding (MT v150 section F)', () => {
    it('rejects non-integer unit prices and item totals', () => {
      const d = draft({ items: [{ quantity: 1, unitPrice: 100.5, vatRate: 10 }] });
      expect(validateInvoiceDraft(d, {})).toContainEqual(
        expect.objectContaining({ field: 'items[0].unitPrice', rule: 'pyg-integer' }),
      );
      const q = draft({ items: [{ quantity: 1.5, unitPrice: 101, vatRate: 5 }] });
      expect(validateInvoiceDraft(q, {})).toContainEqual(
        expect.objectContaining({ field: 'items[0].total', rule: 'pyg-integer' }),
      );
    });

    it('accepts rounding down to a multiple of 50', () => {
      const d = draft({
        items: [{ quantity: 1, unitPrice: 107_437, vatRate: 10 }],
        roundingPyg: 37,
      });
      expect(validateInvoiceDraft(d, {})).toEqual([]);
    });

    it('rejects a total that is not a multiple of 50 after rounding', () => {
      const d = draft({ items: [{ quantity: 1, unitPrice: 47_789, vatRate: 10 }], roundingPyg: 0 });
      expect(validateInvoiceDraft(d, {})).toEqual([
        expect.objectContaining({ field: 'roundingPyg', rule: 'rounding-multiple-of-50' }),
      ]);
    });

    it('rejects a rounding outside 0..49', () => {
      const d = draft({
        items: [{ quantity: 1, unitPrice: 107_450, vatRate: 10 }],
        roundingPyg: 50,
      });
      expect(rules(d)).toContain('rounding-multiple-of-50');
    });
  });

  it('rejects an unknown department (cDepEmi)', () => {
    expect(validateInvoiceDraft(draft({ location: { departmentCode: 99 } }), {})).toEqual([
      expect.objectContaining({ field: 'location.departmentCode', rule: 'department-code' }),
    ]);
  });

  describe('items', () => {
    const one = (item: Partial<InvoiceDraft['items'][number]>) =>
      draft({ items: [{ quantity: 1, unitPrice: 100_000, vatRate: 10, ...item }] });

    it('requires at least one item', () => {
      expect(validateInvoiceDraft(draft({ items: [] }), {})).toContainEqual(
        expect.objectContaining({ field: 'items', rule: 'items-required' }),
      );
    });

    it('rejects non-positive quantity', () => {
      for (const quantity of [0, -1]) {
        expect(validateInvoiceDraft(one({ quantity }), {})).toContainEqual(
          expect.objectContaining({ field: 'items[0].quantity', rule: 'quantity-positive' }),
        );
      }
    });

    it('rejects negative unit price but allows zero (free-of-charge item)', () => {
      expect(validateInvoiceDraft(one({ unitPrice: -50 }), {})).toContainEqual(
        expect.objectContaining({ field: 'items[0].unitPrice', rule: 'unit-price-non-negative' }),
      );
      expect(validateInvoiceDraft(one({ unitPrice: 0 }), {})).toEqual([]);
    });

    it('rejects an unsupported VAT rate at runtime', () => {
      const bad = one({ vatRate: 7 as never });
      expect(validateInvoiceDraft(bad, {})).toContainEqual(
        expect.objectContaining({ field: 'items[0].vatRate', rule: 'vat-rate' }),
      );
    });

    it('does not let a negative line offset the total past the threshold', () => {
      const d = draft({
        receiver: { kind: 'unnamed' },
        operationType: 'B2C',
        items: [
          { quantity: 1, unitPrice: 8_000_000, vatRate: 10 },
          { quantity: 1, unitPrice: -5_000_000, vatRate: 10 },
        ],
      });
      expect(rules(d)).toContain('unnamed-receiver-over-threshold');
    });

    it('still checks the threshold when an item total is non-integer', () => {
      const d = draft({
        receiver: { kind: 'unnamed' },
        operationType: 'B2C',
        items: [{ quantity: 1, unitPrice: 7_000_000.5, vatRate: 10 }],
      });
      expect(rules(d)).toEqual(
        expect.arrayContaining(['pyg-integer', 'unnamed-receiver-over-threshold']),
      );
    });
  });

  it('collects all errors instead of stopping at the first', () => {
    const d = draft({
      receiver: { kind: 'unnamed' },
      operationType: 'B2C',
      items: [
        { quantity: 1, unitPrice: 8_000_001, vatRate: 10 },
        { quantity: 0, unitPrice: 10, vatRate: 7 as never },
      ],
      location: { departmentCode: 0 },
    });
    expect(rules(d).sort()).toEqual(
      [
        'department-code',
        'quantity-positive',
        'rounding-multiple-of-50',
        'unnamed-receiver-over-threshold',
        'vat-rate',
      ].sort(),
    );
    const oee = draft({
      receiver: { kind: 'named', isPublicEntity: true },
      operationType: 'B2B',
      items: [{ quantity: -1, unitPrice: 1, vatRate: 5 }],
    });
    expect(rules(oee)).toEqual(
      expect.arrayContaining(['public-entity-requires-b2g', 'quantity-positive']),
    );
  });

  describe('amount range (numeric(23,8) column)', () => {
    it('rejects a line total beyond 15 integer digits', () => {
      const d = draft({ items: [{ quantity: 1, unitPrice: 1e15, vatRate: 10 }] });
      expect(validateInvoiceDraft(d, {})).toContainEqual(
        expect.objectContaining({ field: 'items[0].total', rule: 'amount-range' }),
      );
    });

    it('rejects an invoice total beyond the range even when every line fits', () => {
      const line = { quantity: 1, unitPrice: 600_000_000_000_000, vatRate: 10 } as const;
      const errors = validateInvoiceDraft(draft({ items: [line, line] }), {});
      expect(errors).toContainEqual(
        expect.objectContaining({ field: 'total', rule: 'amount-range' }),
      );
    });

    it('accepts the largest allowed total', () => {
      const d = draft({ items: [{ quantity: 1, unitPrice: 999_999_999_999_950, vatRate: 10 }] });
      expect(rules(d)).not.toContain('amount-range');
    });
  });
});
