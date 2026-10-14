import { describe, expect, it } from 'vitest';
import { validateInvoiceDraft, type InvoiceDraft } from './invoice-draft.js';

const address = { street: 'Av. Mariscal Lopez', houseNumber: '123', cityCode: 1 };
const named = { kind: 'named', isPublicEntity: false, address } as const;

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

const decimals = { allowDecimals: true };
const rules = (d: InvoiceDraft, config = {}) => validateInvoiceDraft(d, config).map((e) => e.rule);

describe('validateInvoiceDraft', () => {
  it('accepts a valid draft', () => {
    expect(validateInvoiceDraft(draft(), {})).toEqual([]);
  });

  describe('unnamed receiver (D208c / 1321, NT 024)', () => {
    const unnamed = (price: number, rounding = 0) =>
      draft({
        receiver: { kind: 'unnamed' },
        location: {},
        operationType: 'B2C',
        items: [{ quantity: 1, unitPrice: price, vatRate: 10 }],
        roundingPyg: rounding,
      });

    it.each(['B2B', 'B2G', 'B2F'] as const)(
      'rejects an innominado receiver in %s operations (D208b / 1319)',
      (operationType) => {
        const errors = validateInvoiceDraft({ ...unnamed(100_000), operationType }, {});

        expect(errors).toContainEqual(
          expect.objectContaining({
            field: 'operationType',
            rule: 'unnamed-receiver-requires-b2c',
            sifenCode: '1319',
          }),
        );
      },
    );

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
    const oee = { kind: 'named', isPublicEntity: true, address } as const;

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
    it('accepts decimal prices and quantities that SIFEN allows (HU-E5-09)', () => {
      // 2.3 x 100 is 229.99999999999997 with number arithmetic; exactly 230 here.
      const a = draft({ items: [{ quantity: 2.3, unitPrice: 100, vatRate: 10 }], roundingPyg: 30 });
      expect(validateInvoiceDraft(a, decimals)).toEqual([]);
      const b = draft({
        items: [{ quantity: 0.5, unitPrice: 1001, vatRate: 10 }],
        roundingPyg: 0.5,
      });
      expect(validateInvoiceDraft(b, decimals)).toEqual([]);
      const c = draft({
        items: [{ quantity: 1, unitPrice: 100.12345678, vatRate: 10 }],
        roundingPyg: 0.12345678,
      });
      expect(rules(c, decimals)).toEqual(['rounding-multiple-of-50']);
    });

    it('rejects a unit price with more than 8 decimals or 15 integer digits', () => {
      const tooMany = draft({ items: [{ quantity: 1, unitPrice: 1.123456789, vatRate: 10 }] });
      expect(validateInvoiceDraft(tooMany, decimals)).toContainEqual(
        expect.objectContaining({ field: 'items[0].unitPrice', rule: 'unit-price-precision' }),
      );
      const digits = draft({ items: [{ quantity: 1, unitPrice: 1e15, vatRate: 10 }] });
      expect(rules(digits, decimals)).toEqual(
        expect.arrayContaining(['unit-price-precision', 'amount-range']),
      );
    });

    it('rejects a unit price that a JSON number cannot hold exactly', () => {
      const d = draft({ items: [{ quantity: 1, unitPrice: 0.1 + 0.2, vatRate: 10 }] });
      expect(rules(d, decimals)).toContain('unit-price-precision');
    });

    it('rejects a quantity with more than 8 decimals or 10 integer digits', () => {
      for (const quantity of [0.123456789, 12_345_678_901]) {
        const d = draft({ items: [{ quantity, unitPrice: 1, vatRate: 10 }] });
        expect(validateInvoiceDraft(d, decimals)).toContainEqual(
          expect.objectContaining({ field: 'items[0].quantity', rule: 'quantity-precision' }),
        );
      }
    });

    it('rejects a line whose exact product needs more than 8 decimals', () => {
      const d = draft({ items: [{ quantity: 0.00001, unitPrice: 0.0001, vatRate: 10 }] });
      expect(validateInvoiceDraft(d, decimals)).toContainEqual(
        expect.objectContaining({ field: 'items[0].total', rule: 'line-total-precision' }),
      );
    });

    it('rejects a fractional rounding beyond 4 decimals or outside 0..49', () => {
      const items = [{ quantity: 1, unitPrice: 100.00001, vatRate: 10 as const }];
      expect(rules(draft({ items, roundingPyg: 0.00001 }), decimals)).toContain(
        'rounding-multiple-of-50',
      );
      expect(rules(draft({ items, roundingPyg: -0.5 }), decimals)).toContain(
        'rounding-multiple-of-50',
      );
    });

    it('keeps the integer-only rules while decimals are not enabled', () => {
      const d = draft({ items: [{ quantity: 2.3, unitPrice: 100, vatRate: 10 }], roundingPyg: 30 });
      expect(validateInvoiceDraft(d, {})).toEqual([]);
      const half = draft({ items: [{ quantity: 1, unitPrice: 100.5, vatRate: 10 }] });
      expect(rules(half)).toContain('pyg-integer');
      const fractionalRounding = draft({
        items: [{ quantity: 1, unitPrice: 1001, vatRate: 10 }],
        roundingPyg: 1.5,
      });
      expect(rules(fractionalRounding)).toContain('rounding-multiple-of-50');
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
      receiver: { kind: 'named', isPublicEntity: true, address },
      operationType: 'B2B',
      items: [{ quantity: -1, unitPrice: 1, vatRate: 5 }],
    });
    expect(rules(oee)).toEqual(
      expect.arrayContaining(['public-entity-requires-b2g', 'quantity-positive']),
    );
  });

  describe('amount range (numeric(23,8) column)', () => {
    it('rejects a line total beyond 15 integer digits', () => {
      const d = draft({ items: [{ quantity: 2, unitPrice: 999_999_999_999_999, vatRate: 10 }] });
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

  describe('receiver address (D213-D223, NT 003/014)', () => {
    const noAddress = { kind: 'named', isPublicEntity: false } as const;
    const optional = (overrides: Partial<InvoiceDraft> = {}) =>
      draft({ receiver: noAddress, location: {}, ...overrides });

    it('accepts a named receiver without address for B2B, B2C and B2G', () => {
      for (const operationType of ['B2B', 'B2C', 'B2G'] as const) {
        expect(validateInvoiceDraft(optional({ operationType }), {})).toEqual([]);
      }
    });

    it('requires the house number when the address is informed (D218 / 4470)', () => {
      const d = draft({ receiver: { ...named, address: { street: 'Av. X', cityCode: 1 } } });
      expect(validateInvoiceDraft(d, {})).toEqual([
        expect.objectContaining({
          field: 'receiver.houseNumber',
          rule: 'receiver-house-number-required',
          sifenCode: '4470',
        }),
      ]);
    });

    it('requires department and city when the address is informed outside B2F (D219/D223)', () => {
      const d = draft({
        receiver: { ...named, address: { street: 'Av. X', houseNumber: '1' } },
        location: {},
      });
      expect(rules(d)).toEqual(['receiver-department-required', 'receiver-city-required']);
    });

    it('rejects department, house number or city without an address (all or nothing)', () => {
      expect(rules(optional({ location: { departmentCode: 1 } }))).toEqual([
        'receiver-address-required',
      ]);
    });

    it('ignores the department of an unnamed receiver (legacy clients always sent it)', () => {
      const unnamed = draft({
        receiver: { kind: 'unnamed' },
        operationType: 'B2C',
        location: { departmentCode: 11 },
      });

      expect(validateInvoiceDraft(unnamed, {})).toEqual([]);
    });

    it('still checks the department code against the table for an unnamed receiver', () => {
      const unnamed = draft({
        receiver: { kind: 'unnamed' },
        operationType: 'B2C',
        location: { departmentCode: 99 },
      });

      expect(rules(unnamed)).toEqual(['department-code']);
    });

    it('requires an address for B2F (4478)', () => {
      expect(validateInvoiceDraft(optional({ operationType: 'B2F' }), {})).toEqual([
        expect.objectContaining({
          field: 'receiver.address',
          rule: 'receiver-address-required',
          sifenCode: '4478',
        }),
      ]);
    });

    it('rejects department and city for B2F (D219/D223 must not be informed)', () => {
      expect(rules(draft({ operationType: 'B2F' }))).toEqual([
        'receiver-department-not-allowed',
        'receiver-city-not-allowed',
      ]);
    });

    it('accepts B2F with an address and no department or city', () => {
      const d = draft({
        operationType: 'B2F',
        receiver: { ...named, address: { street: 'Main St', houseNumber: '1' } },
        location: {},
      });
      expect(validateInvoiceDraft(d, {})).toEqual([]);
    });
  });
});
