import { describe, expect, it } from 'vitest';
import { validateInvoiceDraft, type InvoiceDraft } from './invoice-draft.js';

/**
 * Golden rules (HU-E5-09). `BEFORE` is what validateInvoiceDraft returned on origin/main (b8ee5e7,
 * before the Decimal work) with the default config, as `field:rule`, sorted. It was recorded by
 * running these same drafts in a temporary worktree of that commit. The current code must return
 * the same, except for the explicit `INTENDED_CHANGES`.
 */
const named = { kind: 'named', isPublicEntity: false } as const;
const unnamed = { kind: 'unnamed' } as const;
type Item = InvoiceDraft['items'][number];
const d = (items: Item[], roundingPyg = 0, extra: Partial<InvoiceDraft> = {}): InvoiceDraft => ({
  receiver: named,
  operationType: 'B2B',
  items,
  roundingPyg,
  location: {},
  ...extra,
});
const line = (quantity: number, unitPrice: number): Item => ({ quantity, unitPrice, vatRate: 10 });
const CASES: Record<string, InvoiceDraft> = {
  'integer ok': d([line(1, 110_000)]),
  'integer rounding 37': d([line(1, 107_437)], 37),
  'integer needs rounding': d([line(1, 47_789)], 0),
  'rounding 50': d([line(1, 107_450)], 50),
  'free item': d([line(1, 0)]),
  'max total': d([line(1, 999_999_999_999_950)]),
  'two lines over range': d([line(1, 600_000_000_000_000), line(1, 600_000_000_000_000)]),
  '2.3 x 100 r0': d([line(2.3, 100)], 0),
  '2.3 x 100 r30': d([line(2.3, 100)], 30),
  '0.3333333333333333 x 3': d([line(0.3333333333333333, 3)], 0),
  'quantity 1e11': d([line(1e11, 1)], 0),
  'unitPrice 1e15': d([line(1, 1e15)], 0),
  'unitPrice 1e20': d([line(1, 1e20)], 0),
  '16 digit integer price': d([line(1, 1_234_567_890_123_456)], 0),
  '1.5 x 1001': d([line(1.5, 1001)], 0),
  'price 100.5': d([line(1, 100.5)], 0),
  'quantity zero': d([line(0, 100)], 0),
  'quantity negative': d([line(-1, 100)], 0),
  'price negative': d([line(1, -1)], 0),
  'quantity NaN': d([line(Number.NaN, 100)], 0),
  'vat 7': d([{ quantity: 1, unitPrice: 100, vatRate: 7 as never }], 0),
  'no items': d([], 0),
  'fractional rounding': d([line(1, 1001)], 1.5),
  'negative rounding': d([line(1, 1000)], -50),
  'unnamed over threshold': d([line(1, 8_000_000)], 0, { receiver: unnamed, operationType: 'B2C' }),
  'unnamed fractional over threshold': d([line(1, 7_000_000.5)], 0, {
    receiver: unnamed,
    operationType: 'B2C',
  }),
  'big quantity x price in range': d([line(1_000_000, 999_999)], 0),
  'quantity 1000000.5 x 3': d([line(1_000_000.5, 3)], 0),
};

const BEFORE: Record<string, string[]> = {
  'integer ok': [],
  'integer rounding 37': [],
  'integer needs rounding': ['roundingPyg:rounding-multiple-of-50'],
  'rounding 50': ['roundingPyg:rounding-multiple-of-50'],
  'free item': [],
  'max total': [],
  'two lines over range': ['total:amount-range'],
  '2.3 x 100 r0': ['items[0].total:pyg-integer'],
  '2.3 x 100 r30': ['items[0].total:pyg-integer'],
  '0.3333333333333333 x 3': ['roundingPyg:rounding-multiple-of-50'],
  'quantity 1e11': [],
  'unitPrice 1e15': ['items[0].total:amount-range', 'total:amount-range'],
  'unitPrice 1e20': ['items[0].total:amount-range', 'total:amount-range'],
  '16 digit integer price': [
    'items[0].total:amount-range',
    'roundingPyg:rounding-multiple-of-50',
    'total:amount-range',
  ],
  '1.5 x 1001': ['items[0].total:pyg-integer'],
  'price 100.5': ['items[0].total:pyg-integer', 'items[0].unitPrice:pyg-integer'],
  'quantity zero': ['items[0].quantity:quantity-positive'],
  'quantity negative': ['items[0].quantity:quantity-positive'],
  'price negative': ['items[0].unitPrice:unit-price-non-negative'],
  'quantity NaN': [
    'items[0].quantity:quantity-positive',
    'items[0].total:amount-range',
    'items[0].total:pyg-integer',
  ],
  'vat 7': ['items[0].vatRate:vat-rate'],
  'no items': ['items:items-required'],
  'fractional rounding': ['roundingPyg:rounding-multiple-of-50'],
  'negative rounding': ['roundingPyg:rounding-multiple-of-50'],
  'unnamed over threshold': ['receiver:unnamed-receiver-over-threshold'],
  'unnamed fractional over threshold': [
    'items[0].total:pyg-integer',
    'items[0].unitPrice:pyg-integer',
    'receiver:unnamed-receiver-over-threshold',
  ],
  'big quantity x price in range': [],
  'quantity 1000000.5 x 3': ['items[0].total:pyg-integer'],
};

/** Intended behavior changes: the new result for each draft whose result differs from BEFORE. */
const INTENDED_CHANGES: Record<string, string[]> = {
  '2.3 x 100 r0': ['roundingPyg:rounding-multiple-of-50'],
  '2.3 x 100 r30': [],
  '0.3333333333333333 x 3': ['items[0].quantity:quantity-precision'],
  'quantity 1e11': ['items[0].quantity:quantity-precision'],
  'unitPrice 1e15': [
    'items[0].total:amount-range',
    'items[0].unitPrice:unit-price-precision',
    'total:amount-range',
  ],
  'unitPrice 1e20': [
    'items[0].total:amount-range',
    'items[0].unitPrice:unit-price-precision',
    'total:amount-range',
  ],
  '16 digit integer price': [
    'items[0].total:amount-range',
    'items[0].unitPrice:unit-price-precision',
    'total:amount-range',
  ],
  'quantity NaN': ['items[0].quantity:quantity-positive'],
};

const result = (draft: InvoiceDraft) =>
  validateInvoiceDraft(draft, {})
    .map((e) => `${e.field}:${e.rule}`)
    .sort();

describe('validateInvoiceDraft golden rules (default config, decimals off)', () => {
  it.each(Object.keys(CASES))('%s', (name) => {
    const expected = INTENDED_CHANGES[name] ?? BEFORE[name];
    expect(result(CASES[name])).toEqual(expected);
  });

  it('lists only drafts that exist and really changed', () => {
    for (const name of Object.keys(INTENDED_CHANGES)) {
      expect(BEFORE[name]).toBeDefined();
      expect(INTENDED_CHANGES[name]).not.toEqual(BEFORE[name]);
    }
  });
});
