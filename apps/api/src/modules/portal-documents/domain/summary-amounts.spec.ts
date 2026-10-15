import { describe, expect, it } from 'vitest';
import { trimDecimals } from './portal-document.js';
import { addAmounts } from './summary-amounts.js';

describe('summary amounts with decimals (HU-E5-09, numeric(23,8))', () => {
  it('adds stored numeric texts exactly', () => {
    expect(addAmounts('0.10000000', '0.20000000')).toBe('0.30000000');
    expect(addAmounts('999999999999999.99999999', '0.00000001')).toBe('1000000000000000.00000000');
    expect(addAmounts('110000.00000000', '12350.50000000')).toBe('122350.50000000');
  });

  it('trims the eight stored decimals without touching significant digits', () => {
    expect(trimDecimals('122350.50000000')).toBe('122350.5');
    expect(trimDecimals('0.00000001')).toBe('0.00000001');
    expect(trimDecimals('100.00000000')).toBe('100');
    expect(trimDecimals('1000.10000000')).toBe('1000.1');
    expect(trimDecimals('0.00000000')).toBe('0');
  });
});
