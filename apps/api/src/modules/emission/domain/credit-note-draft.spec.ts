import { describe, expect, it } from 'vitest';
import {
  CREDIT_NOTE_REASONS,
  creditNoteCurrencyRule,
  creditNoteSumRule,
  validateCreditNoteDraft,
  type AssociatedInvoiceFacts,
  type CreditNoteDraft,
} from './credit-note-draft.js';
import { amount } from './invoice-totals.js';

const FE_CDC = '01800695631001001000000112026010111234567891';

function invoice(overrides: Partial<AssociatedInvoiceFacts> = {}): AssociatedInvoiceFacts {
  return {
    receiver: { kind: 'named', isPublicEntity: false },
    operationType: 'B2B',
    location: {},
    status: 'approved',
    currency: 'PYG',
    totalAmount: '1000000',
    creditedAmount: '0',
    ...overrides,
  };
}

function draft(overrides: Partial<CreditNoteDraft> = {}): CreditNoteDraft {
  return {
    associatedCdc: FE_CDC,
    reasonCode: 2,
    items: [{ quantity: 1, unitPrice: 400_000, vatRate: 10 }],
    roundingPyg: 0,
    ...overrides,
  };
}

const decimals = { allowDecimals: true };
/** `null` is an FE the tenant does not have. */
const check = (d: CreditNoteDraft, i: AssociatedInvoiceFacts | null = invoice()) =>
  validateCreditNoteDraft(d, i ?? undefined, decimals);
const rules = (d: CreditNoteDraft, i: AssociatedInvoiceFacts | null = invoice()) =>
  check(d, i).map((e) => e.rule);

/** Spec: HU-E7-01 (ADR-0019), MT v150 groups E5 and H, validations 240 to 252. */
describe('validateCreditNoteDraft', () => {
  it('accepts a credit under the invoice total', () => {
    expect(check(draft())).toEqual([]);
  });

  describe('reason (E401/E402, 1452)', () => {
    it('has the eight reasons of the Manual Técnico with their fixed descriptions', () => {
      expect(CREDIT_NOTE_REASONS).toEqual({
        1: 'Devolución y Ajuste de precios',
        2: 'Devolución',
        3: 'Descuento',
        4: 'Bonificación',
        5: 'Crédito incobrable',
        6: 'Recupero de costo',
        7: 'Recupero de gasto',
        8: 'Ajuste de precio',
      });
    });

    it.each([0, 9, 1.5, -1, Number.NaN])('rejects reason %s', (reasonCode) => {
      expect(check(draft({ reasonCode }))).toEqual([
        expect.objectContaining({
          field: 'reasonCode',
          rule: 'credit-note-reason',
          sifenCode: '1452',
        }),
      ]);
    });

    it.each([1, 2, 3, 4, 5, 6, 7, 8])('accepts reason %s', (reasonCode) => {
      expect(rules(draft({ reasonCode }))).toEqual([]);
    });
  });

  describe('associated document (H004, 2403, 2404, 2414)', () => {
    it('rejects a CDC that is not an FE (2414) without needing the invoice', () => {
      const nce = `05${FE_CDC.slice(2)}`;
      expect(check(draft({ associatedCdc: nce }), null)).toEqual([
        expect.objectContaining({
          field: 'associatedCdc',
          rule: 'associated-document-not-invoice',
          sifenCode: '2414',
        }),
      ]);
    });

    it('rejects an unknown FE (2403)', () => {
      expect(check(draft(), null)).toEqual([
        expect.objectContaining({
          field: 'associatedCdc',
          rule: 'associated-document-not-found',
          sifenCode: '2403',
        }),
      ]);
    });

    it.each(['cancelled', 'number_voided'])('rejects a %s FE (2404)', (status) => {
      expect(check(draft(), invoice({ status }))).toEqual([
        expect.objectContaining({ rule: 'associated-document-cancelled', sifenCode: '2404' }),
      ]);
    });

    it.each(['accepted', 'signed', 'queued', 'submitted', 'rejected', 'corrected'])(
      'rejects an FE not approved yet (%s) with no SIFEN code',
      (status) => {
        const [error, ...rest] = check(draft(), invoice({ status }));
        expect(rest).toEqual([]);
        expect(error).toMatchObject({ rule: 'associated-document-not-approved' });
        expect(error.sifenCode).toBeUndefined();
      },
    );

    it.each(['approved', 'approved_with_observations'])(
      'accepts an FE %s (ADR-0019 D6)',
      (status) => {
        expect(rules(draft(), invoice({ status }))).toEqual([]);
      },
    );
  });

  describe('receiver (1331)', () => {
    it('rejects crediting an FE issued to an unnamed receiver', () => {
      expect(
        check(draft(), invoice({ receiver: { kind: 'unnamed' }, operationType: 'B2C' })),
      ).toEqual([
        expect.objectContaining({
          field: 'associatedCdc',
          rule: 'credit-note-unnamed-receiver',
          sifenCode: '1331',
        }),
      ]);
    });
  });

  describe('items and rounding reuse the invoice rules', () => {
    it('requires items', () => {
      expect(rules(draft({ items: [] }))).toEqual(['items-required']);
    });

    it('validates quantity, price and VAT rate per item', () => {
      const errors = check(draft({ items: [{ quantity: 0, unitPrice: -1, vatRate: 7 as 10 }] }));
      expect(errors.map((e) => e.rule).sort()).toEqual([
        'quantity-positive',
        'unit-price-non-negative',
        'vat-rate',
      ]);
    });

    it('validates the rounding as the invoice does', () => {
      expect(rules(draft({ items: [{ quantity: 1, unitPrice: 107_437, vatRate: 10 }] }))).toEqual([
        'rounding-multiple-of-50',
      ]);
      expect(
        rules(
          draft({ items: [{ quantity: 1, unitPrice: 107_437, vatRate: 10 }], roundingPyg: 37 }),
        ),
      ).toEqual([]);
    });

    it('keeps the PYG-integer rule while decimals are off', () => {
      const errors = validateCreditNoteDraft(
        draft({ items: [{ quantity: 1, unitPrice: 100.5, vatRate: 10 }] }),
        invoice(),
        {},
      );
      expect(errors.map((e) => e.rule)).toContain('pyg-integer');
    });
  });

  describe('sum of credits (H004d, 2417)', () => {
    it('accepts a credit that exactly completes the invoice', () => {
      expect(rules(draft(), invoice({ creditedAmount: '600000' }))).toEqual([]);
    });

    it('rejects a credit that exceeds what is left', () => {
      expect(check(draft(), invoice({ creditedAmount: '700000' }))).toEqual([
        expect.objectContaining({
          field: 'items',
          rule: 'credit-note-sum-exceeds-invoice',
          sifenCode: '2417',
        }),
      ]);
    });

    it('is skipped when the items are invalid, so the errors are not doubled', () => {
      expect(rules(draft({ items: [] }), invoice({ creditedAmount: '999999' }))).toEqual([
        'items-required',
      ]);
    });
  });

  it('collects every violation at once', () => {
    expect(
      rules(draft({ reasonCode: 0, items: [] }), invoice({ status: 'cancelled' })).sort(),
    ).toEqual(['associated-document-cancelled', 'credit-note-reason', 'items-required']);
  });
});

describe('creditNoteSumRule', () => {
  it('compares exact decimals: one unit over is refused, equal is accepted', () => {
    const total = amount('1000000.00000001');
    expect(creditNoteSumRule(total, amount('0.00000001'), amount('1000000'))).toBeUndefined();
    expect(creditNoteSumRule(total, amount('0.00000002'), amount('1000000'))?.sifenCode).toBe(
      '2417',
    );
  });
});

describe('creditNoteCurrencyRule (2438)', () => {
  it('passes for PYG against PYG and refuses any other FE currency', () => {
    expect(creditNoteCurrencyRule('PYG')).toBeUndefined();
    expect(creditNoteCurrencyRule('USD')).toMatchObject({
      rule: 'credit-note-currency-mismatch',
      sifenCode: '2438',
    });
  });
});
