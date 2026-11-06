import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { Decimal } from '../../emission/domain/decimal.js';
import {
  DEFAULT_TOTALS_TOLERANCE,
  validateReceivedDocument,
  validateTotals,
  type ReceivedDocumentFields,
  type ReceivedTotals,
} from './received-document-validation.js';

const dec = (s: string): Decimal => {
  const r = Decimal.parse(s);
  if (!r.ok) throw new Error(s);
  return r.value;
};

const totals = (over: Partial<ReceivedTotals> = {}): ReceivedTotals => ({
  exempt: '0',
  exonerated: '0',
  taxable5: '0',
  taxable10: '0',
  vat5: '0',
  vat10: '0',
  total: '0',
  ...over,
});

describe('validateTotals (ported from project A test_validacion_factura)', () => {
  it('passes the real factura_contado fixture values', () => {
    const t = totals({ taxable10: '185454.54545455', vat10: '18545.45454545', total: '204000' });
    expect(validateTotals(t, ['204000'])).toEqual([]);
  });

  it('flags an inconsistent 10% VAT', () => {
    const t = totals({ taxable10: '100000', vat10: '5000', total: '105000' });
    expect(validateTotals(t, [])).toEqual(['vat10_inconsistent']);
  });

  it('flags an inconsistent 5% VAT', () => {
    const t = totals({ taxable5: '100000', vat5: '1000', total: '101000' });
    expect(validateTotals(t, [])).toEqual(['vat5_inconsistent']);
  });

  it('flags blocks that do not add up to the total', () => {
    const t = totals({ taxable10: '100000', vat10: '10000', total: '999999' });
    expect(validateTotals(t, [])).toEqual(['totals_blocks_sum_mismatch']);
  });

  it('does not flag rounding within the default tolerance', () => {
    const t = totals({ taxable10: '100000', vat10: '10000.4', total: '110000.4' });
    expect(validateTotals(t, [])).toEqual([]);
  });

  it('flags a difference beyond the tolerance and honours a custom one', () => {
    const t = totals({ taxable10: '100000', vat10: '10000', total: '110002' });
    expect(validateTotals(t, [])).toEqual(['totals_blocks_sum_mismatch']);
    expect(validateTotals(t, [], dec('5'))).toEqual([]);
  });

  it('exposes the ADR-0021 default tolerance of 1', () => {
    expect(DEFAULT_TOTALS_TOLERANCE.equals(dec('1'))).toBe(true);
  });

  it('adds the items check only when items are provided', () => {
    const t = totals({ taxable10: '100000', vat10: '10000', total: '110000' });
    expect(validateTotals(t, [])).toEqual([]);
    expect(validateTotals(t, ['50000', '50000'])).toEqual(['items_sum_mismatch']);
    expect(validateTotals(t, ['100000', '10000'])).toEqual([]);
  });

  it('reports invalid_amount instead of throwing on non-decimal strings', () => {
    expect(validateTotals(totals({ total: 'abc' }), [])).toEqual(['invalid_amount']);
    expect(validateTotals(totals({ vat10: '1e400' }), [])).toEqual(['invalid_amount']);
  });

  it('property: consistent blocks always pass, a total off by more than tolerance never does', () => {
    const gs = fc.integer({ min: 0, max: 999_999_999 });
    fc.assert(
      fc.property(gs, gs, gs, gs, (exempt, exonerated, base5, base10) => {
        const vat5 = dec(String(base5)).multiply(dec('0.05'), 'half-even').roundTo(2, 'half-even');
        const vat10 = dec(String(base10)).multiply(dec('0.1'), 'half-even').roundTo(2, 'half-even');
        const sum = dec(String(exempt))
          .add(dec(String(exonerated)))
          .add(dec(String(base5)))
          .add(vat5)
          .add(dec(String(base10)))
          .add(vat10);
        const base = {
          exempt: String(exempt),
          exonerated: String(exonerated),
          taxable5: String(base5),
          taxable10: String(base10),
          vat5: vat5.toString(),
          vat10: vat10.toString(),
        };
        expect(validateTotals({ ...base, total: sum.toString() }, [])).toEqual([]);
        const off = sum.add(dec('1.01')).toString();
        expect(validateTotals({ ...base, total: off }, [])).toEqual(['totals_blocks_sum_mismatch']);
      }),
    );
  });
});

const valid = (): ReceivedDocumentFields => ({
  cdc: '01444444017001001001452822017012515873260988',
  issuerRuc: '4490207-7',
  issuerLegalName: 'ACME SA',
  documentNumber: '001-001-0001234',
  issueDate: '2026-01-15',
  totals: totals({ taxable10: '100000', vat10: '10000', total: '110000' }),
  itemAmounts: ['110000'],
});

describe('validateReceivedDocument', () => {
  it('returns no reasons for a consistent document', () => {
    expect(validateReceivedDocument(valid())).toEqual([]);
  });

  it('accepts a paper document without a CDC', () => {
    expect(validateReceivedDocument({ ...valid(), cdc: null })).toEqual([]);
  });

  it('reports every missing required field', () => {
    const reasons = validateReceivedDocument({
      cdc: null,
      issuerRuc: null,
      issuerLegalName: ' ',
      documentNumber: null,
      issueDate: null,
      totals: null,
      itemAmounts: [],
    });
    expect(reasons).toEqual([
      'missing_issuer_ruc',
      'missing_issuer_legal_name',
      'missing_document_number',
      'missing_issue_date',
      'missing_totals',
    ]);
  });

  it('checks the document number format EEE-PPP-NNNNNNN', () => {
    expect(validateReceivedDocument({ ...valid(), documentNumber: '1-1-1' })).toEqual([
      'invalid_document_number_format',
    ]);
  });

  it('flags a RUC with a wrong check digit and a malformed RUC', () => {
    expect(validateReceivedDocument({ ...valid(), issuerRuc: '4490207-1' })).toEqual([
      'issuer_ruc_check_digit_mismatch',
    ]);
    expect(validateReceivedDocument({ ...valid(), issuerRuc: 'xx' })).toEqual([
      'issuer_ruc_invalid_format',
    ]);
  });

  it('flags a CDC with a wrong check digit or malformed', () => {
    expect(
      validateReceivedDocument({ ...valid(), cdc: '01444444017001001001452822017012515873260989' }),
    ).toEqual(['cdc_check_digit_mismatch']);
    expect(validateReceivedDocument({ ...valid(), cdc: '123' })).toEqual(['cdc_invalid']);
  });

  it('flags a bad issue date', () => {
    expect(validateReceivedDocument({ ...valid(), issueDate: '2026-02-31' })).toEqual([
      'invalid_issue_date',
    ]);
  });

  it('accumulates distinct reasons without duplicates and honours the tolerance option', () => {
    const doc = {
      ...valid(),
      totals: totals({ taxable10: '100000', vat10: '10000', total: '110003' }),
    };
    expect(validateReceivedDocument(doc)).toEqual([
      'totals_blocks_sum_mismatch',
      'items_sum_mismatch',
    ]);
    expect(validateReceivedDocument(doc, { tolerance: dec('5') })).toEqual([]);
  });
});
