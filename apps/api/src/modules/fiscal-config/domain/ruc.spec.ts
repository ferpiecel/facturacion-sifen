import { describe, expect, it } from 'vitest';
import { computeRucCheckDigit, createRuc, formatRuc, InvalidRucError, parseRuc } from './ruc.js';

describe('computeRucCheckDigit', () => {
  it('computes the SET modulo-11 check digit for the PO real RUC (4490207)', () => {
    expect(computeRucCheckDigit('4490207')).toBe(7);
  });

  it('computes the check digit for other known bases', () => {
    expect(computeRucCheckDigit('1234567')).toBe(9);
    expect(computeRucCheckDigit('8')).toBe(6);
    expect(computeRucCheckDigit('123')).toBe(6);
    expect(computeRucCheckDigit('12345678')).toBe(9);
  });

  it('rejects a base outside 3 to 8 digits', () => {
    expect(() => computeRucCheckDigit('12')).toThrow(InvalidRucError);
    expect(() => computeRucCheckDigit('123456789')).toThrow(InvalidRucError);
  });

  it('rejects a non-digit base', () => {
    expect(() => computeRucCheckDigit('abc1234')).toThrow(InvalidRucError);
    expect(() => computeRucCheckDigit('')).toThrow(InvalidRucError);
  });
});

describe('createRuc', () => {
  it('accepts the PO real RUC 4490207-7', () => {
    const ruc = createRuc('4490207', 7);
    expect(ruc).toEqual({ base: '4490207', dv: 7 });
  });

  it('rejects a wrong check digit', () => {
    expect(() => createRuc('4490207', 8)).toThrow(InvalidRucError);
  });
});

describe('parseRuc', () => {
  it('parses "4490207-7"', () => {
    expect(parseRuc('4490207-7')).toEqual({ base: '4490207', dv: 7 });
  });

  it.each([
    ['missing dash', '44902077'],
    ['non-digit base', 'ABCDEFG-7'],
    ['too many base digits', '123456789-9'],
    ['too few base digits', '12-6'],
    ['empty string', ''],
    ['trailing garbage', '4490207-7x'],
    ['multi-digit dv', '4490207-77'],
  ])('rejects %s', (_label, raw) => {
    expect(() => parseRuc(raw)).toThrow(InvalidRucError);
  });

  it('rejects a well-formed but incorrect check digit', () => {
    expect(() => parseRuc('4490207-1')).toThrow(InvalidRucError);
  });
});

describe('formatRuc', () => {
  it('formats back to "<base>-<dv>"', () => {
    expect(formatRuc({ base: '4490207', dv: 7 })).toBe('4490207-7');
  });
});
