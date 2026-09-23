import { describe, expect, it } from 'vitest';
import { toCdc } from '../src/types.ts';

describe('toCdc', () => {
  it('accepts a 44-digit string', () => {
    const value = '1'.repeat(44);

    expect(toCdc(value)).toBe(value);
  });

  it('rejects a string shorter than 44 digits', () => {
    expect(() => toCdc('1'.repeat(43))).toThrow(RangeError);
  });

  it('rejects a string longer than 44 digits', () => {
    expect(() => toCdc('1'.repeat(45))).toThrow(RangeError);
  });

  it('rejects a 44-character string with non-digit characters', () => {
    expect(() => toCdc(`${'1'.repeat(43)}a`)).toThrow(RangeError);
  });
});
