import { describe, expect, it } from 'vitest';
import {
  validateDebitNoteDraft,
  type AssociatedInvoiceFacts,
  type CreditNoteDraft,
} from './credit-note-draft.js';

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

const check = (d: CreditNoteDraft, i: AssociatedInvoiceFacts | null = invoice()) =>
  validateDebitNoteDraft(d, i ?? undefined, { allowDecimals: true });
const rules = (d: CreditNoteDraft, i: AssociatedInvoiceFacts | null = invoice()) =>
  check(d, i).map((e) => e.rule);

/** Spec: HU-E7-02, MT v150 groups E5 and H (validations 240 to 252). An NDE adds to the FE. */
describe('validateDebitNoteDraft', () => {
  it('accepts a debit of any amount: the 2417 sum names credit notes only', () => {
    const big = draft({ items: [{ quantity: 1, unitPrice: 5_000_000, vatRate: 10 }] });
    expect(check(big, invoice({ creditedAmount: '900000' }))).toEqual([]);
  });

  it.each([0, 9, 1.5, Number.NaN])('rejects reason %s (1452)', (reasonCode) => {
    expect(check(draft({ reasonCode }))).toEqual([
      expect.objectContaining({
        field: 'reasonCode',
        rule: 'debit-note-reason',
        sifenCode: '1452',
      }),
    ]);
  });

  it.each([1, 2, 3, 4, 5, 6, 7, 8])('accepts reason %s', (reasonCode) => {
    expect(rules(draft({ reasonCode }))).toEqual([]);
  });

  it('rejects a CDC that is not an FE (2414), an unknown FE (2403) and a cancelled one (2404)', () => {
    expect(rules(draft({ associatedCdc: `06${FE_CDC.slice(2)}` }), null)).toEqual([
      'associated-document-not-invoice',
    ]);
    expect(rules(draft(), null)).toEqual(['associated-document-not-found']);
    expect(rules(draft(), invoice({ status: 'cancelled' }))).toEqual([
      'associated-document-cancelled',
    ]);
  });

  it('rejects an FE SIFEN has not approved yet without a SIFEN code', () => {
    const [error] = check(draft(), invoice({ status: 'signed' }));
    expect(error).toMatchObject({ rule: 'associated-document-not-approved' });
    expect(error.sifenCode).toBeUndefined();
  });

  it('rejects an FE issued to an unnamed receiver (1331)', () => {
    expect(
      check(draft(), invoice({ receiver: { kind: 'unnamed' }, operationType: 'B2C' })),
    ).toEqual([
      expect.objectContaining({ rule: 'debit-note-unnamed-receiver', sifenCode: '1331' }),
    ]);
  });

  it('rejects an FE in another currency (2438)', () => {
    expect(check(draft(), invoice({ currency: 'USD' }))).toEqual([
      expect.objectContaining({ rule: 'debit-note-currency-mismatch', sifenCode: '2438' }),
    ]);
  });

  it('reuses the item rules and collects every violation', () => {
    expect(
      rules(draft({ reasonCode: 0, items: [] }), invoice({ status: 'cancelled' })).sort(),
    ).toEqual(['associated-document-cancelled', 'debit-note-reason', 'items-required']);
  });
});
