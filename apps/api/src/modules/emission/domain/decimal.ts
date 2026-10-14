/**
 * Exact decimal value over BigInt scaled integers (scale 8). Pure TypeScript: no framework, no
 * `number` arithmetic. ADR-0018.
 */

const SCALE = 8;
const FACTOR = 10n ** BigInt(SCALE);
const MAX_INTEGER_DIGITS = 15;
const MAX_SIGNIFICANT_DIGITS_FROM_NUMBER = 15;

/** `truncate` goes toward zero, `floor` toward minus infinity, `half-up` rounds halves away from zero. */
export type RoundingMode = 'truncate' | 'floor' | 'half-up' | 'half-even';

export type DecimalParseFailure =
  | 'not-a-decimal'
  | 'not-finite'
  | 'too-many-significant-digits'
  | 'too-many-integer-digits'
  | 'too-many-decimals';

export type DecimalParseResult =
  | { readonly ok: true; readonly value: Decimal }
  | { readonly ok: false; readonly reason: DecimalParseFailure };

const PLAIN = /^(-?)(\d+)(?:\.(\d+))?$/;
const EXPONENT = /^(-?)(\d+)(?:\.(\d+))?e([+-]\d+)$/;

/** Optional regex groups are `undefined` at runtime although typed as `string`. */
function group(match: RegExpExecArray, index: number): string {
  return match.at(index) ?? '';
}

function fail(reason: DecimalParseFailure): DecimalParseResult {
  return { ok: false, reason };
}

function absolute(n: bigint): bigint {
  return n < 0n ? -n : n;
}

/** Divides `n` by a positive `d` and rounds the quotient with `mode`. */
function divideRounded(n: bigint, d: bigint, mode: RoundingMode): bigint {
  const quotient = n / d;
  const remainder = n % d;
  if (remainder === 0n) return quotient;
  const away = n < 0n ? quotient - 1n : quotient + 1n;
  switch (mode) {
    case 'truncate':
      return quotient;
    case 'floor':
      return n < 0n ? away : quotient;
    case 'half-up':
      return absolute(remainder) * 2n >= d ? away : quotient;
    case 'half-even': {
      const twice = absolute(remainder) * 2n;
      if (twice > d) return away;
      return twice === d && quotient % 2n !== 0n ? away : quotient;
    }
  }
}

/** `String(number)` only uses exponents below 1e-6 (negative) or from 1e21 (positive, whole numbers). */
function expandExponent(sign: string, int: string, frac: string, exponent: number): string {
  const digits = int + frac;
  if (exponent < 0) return `${sign}0.${'0'.repeat(-exponent - int.length)}${digits}`;
  return `${sign}${digits}${'0'.repeat(exponent - frac.length)}`;
}

function significantDigits(int: string, frac: string): number {
  return (int + frac).replace(/^0+/, '').replace(/0+$/, '').length;
}

export class Decimal {
  private constructor(private readonly units: bigint) {}

  /** Parses a JSON number (through its shortest decimal string) or a plain decimal string. */
  static parse(input: number | string): DecimalParseResult {
    if (typeof input === 'number') {
      if (!Number.isFinite(input)) return fail('not-finite');
      const text = String(input);
      const exp = EXPONENT.exec(text);
      const plain = exp
        ? expandExponent(group(exp, 1), group(exp, 2), group(exp, 3), Number(group(exp, 4)))
        : text;
      const [int, frac] = plain.replace('-', '').split('.') as [string, string | undefined];
      if (significantDigits(int, frac ?? '') > MAX_SIGNIFICANT_DIGITS_FROM_NUMBER) {
        return fail('too-many-significant-digits');
      }
      return Decimal.parsePlain(plain);
    }
    return Decimal.parsePlain(input);
  }

  private static parsePlain(text: string): DecimalParseResult {
    const parts = PLAIN.exec(text);
    if (!parts) return fail('not-a-decimal');
    const negative = parts[1] === '-';
    const int = group(parts, 2).replace(/^0+(?=\d)/, '');
    const frac = group(parts, 3).replace(/0+$/, '');
    if (int.replace(/^0+$/, '').length > MAX_INTEGER_DIGITS) return fail('too-many-integer-digits');
    if (frac.length > SCALE) return fail('too-many-decimals');
    const magnitude = BigInt(int + frac.padEnd(SCALE, '0'));
    return { ok: true, value: new Decimal(negative ? -magnitude : magnitude) };
  }

  static zero(): Decimal {
    return new Decimal(0n);
  }

  compare(other: Decimal): -1 | 0 | 1 {
    if (this.units === other.units) return 0;
    return this.units < other.units ? -1 : 1;
  }

  equals(other: Decimal): boolean {
    return this.units === other.units;
  }

  isZero(): boolean {
    return this.units === 0n;
  }

  isNegative(): boolean {
    return this.units < 0n;
  }

  negate(): Decimal {
    return new Decimal(-this.units);
  }

  add(other: Decimal): Decimal {
    return new Decimal(this.units + other.units);
  }

  subtract(other: Decimal): Decimal {
    return new Decimal(this.units - other.units);
  }

  /** Product rounded to 8 decimals with the given mode. */
  multiply(other: Decimal, mode: RoundingMode): Decimal {
    return new Decimal(divideRounded(this.units * other.units, FACTOR, mode));
  }

  /** Product, or `undefined` when it needs more than 8 decimals (nothing is rounded). */
  multiplyExact(other: Decimal): Decimal | undefined {
    const raw = this.units * other.units;
    return raw % FACTOR === 0n ? new Decimal(raw / FACTOR) : undefined;
  }

  /** Quotient rounded to 8 decimals with the given mode. */
  divide(other: Decimal, mode: RoundingMode): Decimal {
    if (other.units === 0n) throw new RangeError('Division by zero');
    const sign = other.units < 0n ? -1n : 1n;
    return new Decimal(divideRounded(this.units * FACTOR * sign, absolute(other.units), mode));
  }

  /** Rounds to `decimals` places (0 to 8) with the given mode. */
  roundTo(decimals: number, mode: RoundingMode): Decimal {
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > SCALE) {
      throw new RangeError('Decimals must be an integer from 0 to 8');
    }
    const step = 10n ** BigInt(SCALE - decimals);
    return new Decimal(divideRounded(this.units, step, mode) * step);
  }

  /** Decimal places once trailing zeros are dropped. */
  decimalPlaces(): number {
    return this.fraction().length;
  }

  /** Digits of the integer part; `0.5` has none. */
  integerDigits(): number {
    const int = absolute(this.units) / FACTOR;
    return int === 0n ? 0 : int.toString().length;
  }

  fitsIn(integerDigits: number, decimals: number): boolean {
    return this.integerDigits() <= integerDigits && this.decimalPlaces() <= decimals;
  }

  /** Plain decimal text: no exponent, no trailing zeros. */
  toString(): string {
    const int = (absolute(this.units) / FACTOR).toString();
    const frac = this.fraction();
    const sign = this.units < 0n ? '-' : '';
    return frac === '' ? `${sign}${int}` : `${sign}${int}.${frac}`;
  }

  toJSON(): string {
    return this.toString();
  }

  private fraction(): string {
    return (absolute(this.units) % FACTOR).toString().padStart(SCALE, '0').replace(/0+$/, '');
  }
}
