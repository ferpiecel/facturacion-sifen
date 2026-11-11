import { describe, expect, it } from 'vitest';
import { validateSelfInvoiceDraft, type SelfInvoiceDraft } from './self-invoice-draft.js';

const place = {
  address: 'Calle 1',
  houseNumber: '10',
  departmentCode: 11,
  districtCode: 143,
  cityCode: 3344,
};
const draft: SelfInvoiceDraft = {
  seller: { nature: 1, idType: 1, idNumber: '1234567', name: 'Juan Perez', ...place },
  place,
  certificate: { type: 1, number: '12345678901', control: 'ABCD1234' },
  items: [{ quantity: 2, unitPrice: 50_000, vatRate: 0 }],
  roundingPyg: 0,
};
const rules = (changes: Partial<SelfInvoiceDraft>) =>
  validateSelfInvoiceDraft({ ...draft, ...changes }, {}).map((e) => e.rule);

/** Spec: HU-E7-03. MT v150 E4 (E300-E322), E7 (1503) and H (2416): the AFE has no FE-only rules. */
describe('validateSelfInvoiceDraft', () => {
  it('accepts a complete AFE', () => {
    expect(validateSelfInvoiceDraft(draft, {})).toEqual([]);
  });

  it('closes the seller nature (E301) and the identity document type (E304)', () => {
    expect(rules({ seller: { ...draft.seller, nature: 3 } })).toEqual([
      'self-invoice-seller-nature',
    ]);
    expect(rules({ seller: { ...draft.seller, idType: 5 } })).toEqual([
      'self-invoice-seller-id-type',
    ]);
  });

  it('requires the constancia number and control (H016, H017) and a known type (H014)', () => {
    expect(rules({ certificate: { type: 3, number: '12345678901', control: 'ABCD1234' } })).toEqual(
      ['self-invoice-certificate-type'],
    );
    expect(rules({ certificate: { type: 2, number: '123', control: 'ABCD1234' } })).toEqual([
      'self-invoice-certificate-number',
    ]);
    expect(rules({ certificate: { type: 2, number: '12345678901', control: 'ABC' } })).toEqual([
      'self-invoice-certificate-control',
    ]);
    // The XSD pattern is [0-9A-Za-z-]{8}.
    expect(rules({ certificate: { type: 2, number: '12345678901', control: 'ABCD 234' } })).toEqual(
      ['self-invoice-certificate-control'],
    );
  });

  it('rejects a constancia number with leading zeros: xmlgen would turn it into a number', () => {
    expect(rules({ certificate: { type: 2, number: '00000012345', control: 'ABCD1234' } })).toEqual(
      ['self-invoice-certificate-number'],
    );
  });

  it('reuses the item and rounding rules and checks both places', () => {
    expect(rules({ items: [] })).toEqual(['items-required']);
    expect(rules({ roundingPyg: 20 })).toEqual(['rounding-multiple-of-50']);
    expect(rules({ place: { ...place, departmentCode: 99 } })).toEqual(['place-department-code']);
  });
});
