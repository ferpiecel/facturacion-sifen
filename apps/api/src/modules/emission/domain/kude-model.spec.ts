import { describe, expect, it } from 'vitest';
import {
  formatDateDmy,
  formatDocumentNumber,
  formatPyg,
  formatQuantity,
  assertValidKudeInvoice,
  groupCdc,
  KUDE_CONSULT_URL,
  KUDE_TITLE,
  type KudeInvoice,
} from './kude-model.js';

describe('KuDE formatting', () => {
  it('groups the 44-digit CDC in eleven groups of four (MT 13.4.4)', () => {
    const cdc = '01800695631001001000000612021112917595714694';
    const groups = groupCdc(cdc).split(' ');
    expect(groups).toHaveLength(11);
    expect(groups.every((g) => g.length === 4)).toBe(true);
    expect(groups.join('')).toBe(cdc);
  });

  it('rejects a CDC that is not 44 digits', () => {
    expect(() => groupCdc('123')).toThrow(/44 digits/);
  });

  it('formats PYG with dot thousands separators and a minus sign', () => {
    expect(formatPyg(0)).toBe('0');
    expect(formatPyg(110000)).toBe('110.000');
    expect(formatPyg(1234567890)).toBe('1.234.567.890');
    expect(formatPyg(-5000)).toBe('-5.000');
  });

  it('prints integer amounts exactly as before decimals existed', () => {
    const legacy = (amount: number) =>
      `${amount < 0 ? '-' : ''}${String(Math.abs(amount)).replace(/\B(?=(\d{3})+(?!\d))/g, '.')}`;
    const amounts = [
      0, 1, 50, 999, 1000, 10_990, 107_437, 1_234_567, 999_999_999_999_999, -1, -123_456,
    ];
    for (const amount of amounts) expect(formatPyg(amount)).toBe(legacy(amount));
  });

  it('prints decimal amounts with a decimal comma, trimmed and never in exponent notation', () => {
    expect(formatPyg(500.5)).toBe('500,5');
    expect(formatPyg(1234.5678)).toBe('1.234,5678');
    expect(formatPyg(-12_350.25)).toBe('-12.350,25');
    expect(formatPyg(0.00000001)).toBe('0,00000001');
    expect(formatPyg(1e-7)).toBe('0,0000001');
  });

  it('rejects amounts that are neither safe integers nor exact decimals', () => {
    for (const bad of [0.1 + 0.2, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 60, 1e-9]) {
      expect(() => formatPyg(bad)).toThrow(/integer/);
    }
  });

  it('formats quantities with a decimal comma only when fractional', () => {
    expect(formatQuantity(2)).toBe('2');
    expect(formatQuantity(1500)).toBe('1.500');
    expect(formatQuantity(1.25)).toBe('1,25');
  });

  it('never uses exponent notation for quantities and rejects non-finite ones', () => {
    expect(formatQuantity(1e21)).toBe('1.000.000.000.000.000.000.000');
    expect(formatQuantity(0.0000001)).toBe('0,0000001');
    expect(() => formatQuantity(Number.NaN)).toThrow(/finite/);
  });

  it('formats the document number as est-point-number', () => {
    expect(formatDocumentNumber('001', '002', '0000123')).toBe('001-002-0000123');
  });

  it('formats a date as DD/MM/YYYY', () => {
    expect(formatDateDmy('2019-07-31')).toBe('31/07/2019');
    expect(() => formatDateDmy('31/07/2019')).toThrow(/YYYY-MM-DD/);
  });

  it('keeps the MT 13.3 title and the production consultation URL', () => {
    expect(KUDE_TITLE).toBe('KuDE de Factura Electrónica');
    expect(KUDE_CONSULT_URL.production).toBe('https://ekuatia.set.gov.py/consultas/');
    expect(KUDE_CONSULT_URL.test).toBe('https://ekuatia.set.gov.py/consultas-test/');
  });
});

describe('assertValidKudeInvoice', () => {
  const valid: KudeInvoice = {
    environment: 'test',
    cdc: '01800695631001001000000612021112917595714694',
    qrUrl: 'https://ekuatia.set.gov.py/consultas-test/qr?a=1',
    issuer: { name: 'A', address: 'B', city: 'C', ruc: '1-1' },
    stamp: { number: '1', validFrom: '2018-07-01', validTo: '2019-07-31' },
    establishment: '001',
    point: '001',
    documentNumber: '0000001',
    issuedAt: '2026-01-02T10:15:30',
    operationCondition: 'Contado',
    currency: 'PYG',
    receiver: { kind: 'unnamed' },
    transactionType: 'Venta',
    items: [],
    totals: {
      subtotalExempt: 0,
      subtotal5: 0,
      subtotal10: 0,
      totalOperation: 0,
      totalGs: 0,
      vat5: 0,
      vat10: 0,
      totalVat: 0,
    },
  };

  it('accepts a well-formed invoice', () => {
    expect(() => {
      assertValidKudeInvoice(valid);
    }).not.toThrow();
  });

  it.each([
    ['cdc', { cdc: '12' }],
    ['issuedAt', { issuedAt: '2026-02-30T10:00:00' }],
    ['issuedAt', { issuedAt: '2026-01-02' }],
    ['stamp', { stamp: { number: '1', validFrom: '01/07/2018', validTo: '2019-07-31' } }],
    ['currency', { currency: 'USD' }],
    ['qrUrl', { qrUrl: '' }],
    ['installments', { installments: -1 }],
  ])('rejects an invalid %s', (field, patch) => {
    expect(() => {
      assertValidKudeInvoice({ ...valid, ...patch });
    }).toThrow(new RegExp(field));
  });
});
