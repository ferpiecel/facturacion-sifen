import { describe, expect, it } from 'vitest';
import { Decimal } from './decimal.js';

function dec(input: number | string): Decimal {
  const result = Decimal.parse(input);
  if (!result.ok) throw new Error(`cannot parse ${String(input)}: ${result.reason}`);
  return result.value;
}

const reason = (input: number | string) => {
  const result = Decimal.parse(input);
  return result.ok ? null : result.reason;
};

describe('Decimal.parse', () => {
  it('reads decimal strings exactly', () => {
    expect(dec('2.3').toString()).toBe('2.3');
    expect(dec('100').toString()).toBe('100');
    expect(dec('0.00000001').toString()).toBe('0.00000001');
    expect(dec('-0.5').toString()).toBe('-0.5');
    expect(dec('007.500').toString()).toBe('7.5');
  });

  it('reads numbers through their shortest decimal string', () => {
    expect(dec(2.3).toString()).toBe('2.3');
    expect(dec(0.1).toString()).toBe('0.1');
    expect(dec(1001).toString()).toBe('1001');
    expect(dec(-12.25).toString()).toBe('-12.25');
  });

  it('expands exponent notation that String(number) produces', () => {
    expect(dec(1e-7).toString()).toBe('0.0000001');
    expect(dec(1.5e-7).toString()).toBe('0.00000015');
    expect(dec(-2.5e-7).toString()).toBe('-0.00000025');
    expect(reason(1e21)).toBe('too-many-integer-digits');
    expect(reason(1.2345e25)).toBe('too-many-integer-digits');
  });

  it('treats zero and negative zero as zero', () => {
    expect(dec(0).isZero()).toBe(true);
    expect(dec(-0).toString()).toBe('0');
    expect(dec('-0.0').toString()).toBe('0');
  });

  it('rejects a number with more than 15 significant digits', () => {
    expect(reason(0.1 + 0.2)).toBe('too-many-significant-digits');
    expect(reason(1234567.123456789)).toBe('too-many-significant-digits');
    expect(reason(123456789012345680)).toBe('too-many-significant-digits');
  });

  it('accepts a number with exactly 15 significant digits', () => {
    expect(dec(123456789012345).toString()).toBe('123456789012345');
    expect(dec(1234567.1234567).toString()).toBe('1234567.1234567');
  });

  it('keeps strings beyond 15 significant digits exact', () => {
    expect(dec('999999999999999.99999999').toString()).toBe('999999999999999.99999999');
  });

  it('enforces the 15 integer and 8 decimal digit bounds', () => {
    expect(dec('999999999999999').toString()).toBe('999999999999999');
    expect(reason('1000000000000000')).toBe('too-many-integer-digits');
    expect(reason('0.123456789')).toBe('too-many-decimals');
    expect(reason(1e-9)).toBe('too-many-decimals');
  });

  it('ignores trailing zeros past the eighth decimal', () => {
    expect(dec('1.230000000').toString()).toBe('1.23');
  });

  it('rejects malformed input', () => {
    for (const bad of ['', ' ', '1,5', '1e3', '.5', '5.', '+', '--1', 'abc', '1 2', '0x10']) {
      expect(reason(bad)).toBe('not-a-decimal');
    }
    expect(reason(Number.NaN)).toBe('not-finite');
    expect(reason(Number.POSITIVE_INFINITY)).toBe('not-finite');
  });
});

describe('Decimal comparison and sign', () => {
  it('compares by value regardless of how it was written', () => {
    expect(dec('1.50').compare(dec(1.5))).toBe(0);
    expect(dec('1.5').equals(dec('1.50'))).toBe(true);
    expect(dec('1.5').compare(dec('2'))).toBe(-1);
    expect(dec('-1').compare(dec('-2'))).toBe(1);
    expect(dec('0.00000001').compare(dec('0'))).toBe(1);
  });

  it('reports sign and negation', () => {
    expect(dec('-3').isNegative()).toBe(true);
    expect(dec('3').isNegative()).toBe(false);
    expect(dec('0').isNegative()).toBe(false);
    expect(dec('3').negate().toString()).toBe('-3');
    expect(dec('0').negate().toString()).toBe('0');
  });
});

describe('Decimal addition and subtraction', () => {
  it('adds exactly where numbers drift', () => {
    expect(dec('0.1').add(dec('0.2')).toString()).toBe('0.3');
    expect(dec('0.1').add(dec('0.2')).equals(dec('0.3'))).toBe(true);
  });

  it('handles negatives and zero', () => {
    expect(dec('5').add(dec('-7.5')).toString()).toBe('-2.5');
    expect(dec('5').subtract(dec('5')).toString()).toBe('0');
    expect(dec('1').subtract(dec('0.00000001')).toString()).toBe('0.99999999');
  });
});

describe('Decimal multiplication', () => {
  it('computes 2.3 x 100 as exactly 230', () => {
    expect(2.3 * 100).not.toBe(230);
    expect(dec('2.3').multiply(dec('100'), 'half-up').toString()).toBe('230');
    expect(dec(2.3).multiplyExact(dec(100))?.toString()).toBe('230');
  });

  it('computes 0.5 x 1001 as exactly 500.5', () => {
    expect(dec('0.5').multiply(dec('1001'), 'half-up').toString()).toBe('500.5');
    expect(dec('0.5').multiplyExact(dec('1001'))?.toString()).toBe('500.5');
  });

  it('multiplies by zero and with negatives', () => {
    expect(dec('0').multiply(dec('123.45'), 'half-up').toString()).toBe('0');
    expect(dec('-2').multiply(dec('1.5'), 'half-up').toString()).toBe('-3');
    expect(dec('-2').multiply(dec('-1.5'), 'half-up').toString()).toBe('3');
  });

  it('rounds the product to 8 decimals with the explicit mode', () => {
    const a = dec('0.00000001');
    const half = dec('0.5');
    expect(a.multiply(half, 'half-up').toString()).toBe('0.00000001');
    expect(a.multiply(half, 'half-even').toString()).toBe('0');
    expect(a.multiply(half, 'truncate').toString()).toBe('0');
    expect(a.multiply(half, 'floor').toString()).toBe('0');
    expect(a.negate().multiply(half, 'floor').toString()).toBe('-0.00000001');
    expect(a.negate().multiply(half, 'truncate').toString()).toBe('0');
  });

  it('multiplyExact refuses a product that needs more than 8 decimals', () => {
    expect(dec('0.00000001').multiplyExact(dec('0.5'))).toBeUndefined();
    expect(dec('0.0001').multiplyExact(dec('0.0001'))?.toString()).toBe('0.00000001');
    expect(dec('0.0001').multiplyExact(dec('0.00001'))).toBeUndefined();
  });

  it('keeps full precision at the 15+8 digit bounds', () => {
    const max = dec('999999999999999.99999999');
    expect(max.multiplyExact(dec('1'))?.toString()).toBe('999999999999999.99999999');
    const product = max.multiply(dec('10'), 'half-up');
    expect(product.toString()).toBe('9999999999999999.9999999');
    expect(product.fitsIn(15, 8)).toBe(false);
  });
});

describe('Decimal division', () => {
  it('rounds the quotient to 8 decimals with the explicit mode', () => {
    const one = dec('1');
    const three = dec('3');
    expect(one.divide(three, 'half-up').toString()).toBe('0.33333333');
    expect(dec('2').divide(three, 'half-up').toString()).toBe('0.66666667');
    expect(dec('2').divide(three, 'truncate').toString()).toBe('0.66666666');
    expect(dec('-2').divide(three, 'floor').toString()).toBe('-0.66666667');
    expect(dec('1').divide(dec('-3'), 'half-up').toString()).toBe('-0.33333333');
  });

  it('breaks exact halves according to the mode', () => {
    const tiny = dec('0.00000001');
    expect(tiny.divide(dec('2'), 'half-up').toString()).toBe('0.00000001');
    expect(tiny.divide(dec('2'), 'half-even').toString()).toBe('0');
    expect(dec('0.00000003').divide(dec('2'), 'half-even').toString()).toBe('0.00000002');
  });

  it('divides exactly when the quotient fits', () => {
    expect(dec('110000').divide(dec('1.1'), 'half-up').toString()).toBe('100000');
  });

  it('throws on division by zero', () => {
    expect(() => dec('1').divide(dec('0'), 'half-up')).toThrow(RangeError);
  });
});

describe('Decimal rescaling and digit checks', () => {
  it('rounds to fewer decimals with the explicit mode', () => {
    expect(dec('1.2345').roundTo(2, 'half-up').toString()).toBe('1.23');
    expect(dec('1.235').roundTo(2, 'half-up').toString()).toBe('1.24');
    expect(dec('1.235').roundTo(2, 'half-even').toString()).toBe('1.24');
    expect(dec('1.225').roundTo(2, 'half-even').toString()).toBe('1.22');
    expect(dec('-1.239').roundTo(2, 'truncate').toString()).toBe('-1.23');
    expect(dec('-1.231').roundTo(2, 'floor').toString()).toBe('-1.24');
    expect(dec('1.5').roundTo(0, 'half-up').toString()).toBe('2');
  });

  it('refuses a scale outside 0..8', () => {
    expect(() => dec('1').roundTo(9, 'half-up')).toThrow(RangeError);
    expect(() => dec('1').roundTo(-1, 'half-up')).toThrow(RangeError);
    expect(() => dec('1').roundTo(1.5, 'half-up')).toThrow(RangeError);
  });

  it('counts decimal places without trailing zeros', () => {
    expect(dec('1').decimalPlaces()).toBe(0);
    expect(dec('1.50').decimalPlaces()).toBe(1);
    expect(dec('0.00000001').decimalPlaces()).toBe(8);
    expect(dec('-0.25').decimalPlaces()).toBe(2);
    expect(dec('0').decimalPlaces()).toBe(0);
  });

  it('counts integer digits', () => {
    expect(dec('0.5').integerDigits()).toBe(0);
    expect(dec('1').integerDigits()).toBe(1);
    expect(dec('-999999999999999').integerDigits()).toBe(15);
    expect(dec('0').integerDigits()).toBe(0);
  });

  it('checks the field bounds', () => {
    expect(dec('1234567890.12345678').fitsIn(10, 8)).toBe(true);
    expect(dec('12345678901').fitsIn(10, 8)).toBe(false);
    expect(dec('1.12345').fitsIn(10, 4)).toBe(false);
    expect(dec('1.1234').fitsIn(10, 4)).toBe(true);
    expect(dec('-5').fitsIn(15, 8)).toBe(true);
  });
});

describe('Decimal output', () => {
  it('never uses an exponent', () => {
    expect(dec('0.00000001').toString()).toBe('0.00000001');
    expect(dec('999999999999999').toString()).toBe('999999999999999');
    const big = dec('999999999999999').multiply(dec('999999999999999'), 'half-up');
    expect(big.toString()).toBe('999999999999998000000000000001');
    expect(big.toString()).not.toMatch(/e/i);
  });

  it('serializes to the same plain string in JSON', () => {
    expect(JSON.stringify({ v: dec('2.30') })).toBe('{"v":"2.3"}');
  });
});
