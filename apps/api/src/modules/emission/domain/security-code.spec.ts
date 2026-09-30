import { describe, expect, it } from 'vitest';
import { generateSecurityCode, InvalidDocumentNumberError } from './security-code.js';

/** Builds a fake CSPRNG that yields the given uint32 values in order. */
function fakeRandomBytes(values: number[]) {
  const queue = [...values];
  let calls = 0;
  const randomBytes = (size: number): Buffer => {
    expect(size).toBe(4);
    calls += 1;
    const next = queue.shift();
    if (next === undefined) throw new Error('fake RNG exhausted');
    const buffer = Buffer.alloc(4);
    buffer.writeUInt32BE(next);
    return buffer;
  };
  return { randomBytes, calls: () => calls };
}

/** Spec: HU-E4-03. `dCodSeg` (MT v150): 9 digits, zero-padded, CSPRNG, different from `dNumDoc`. */
describe('generateSecurityCode (dCodSeg)', () => {
  it('returns 9 digits using the real CSPRNG by default', () => {
    for (let i = 0; i < 200; i += 1) {
      expect(generateSecurityCode('0000001')).toMatch(/^\d{9}$/);
    }
  });

  it('zero-pads small values to 9 digits', () => {
    const { randomBytes } = fakeRandomBytes([42]);
    expect(generateSecurityCode('0000001', randomBytes)).toBe('000000042');
  });

  it('covers the full range 000000000..999999999', () => {
    expect(generateSecurityCode('0000001', fakeRandomBytes([0]).randomBytes)).toBe('000000000');
    expect(generateSecurityCode('0000001', fakeRandomBytes([999_999_999]).randomBytes)).toBe(
      '999999999',
    );
  });

  it('rejects draws in the biased tail instead of using modulo', () => {
    // 4_000_000_000 is the first rejected value (2^32 is not a multiple of 1e9).
    const rng = fakeRandomBytes([4_294_967_295, 4_000_000_000, 3_999_999_999]);
    expect(generateSecurityCode('0000001', rng.randomBytes)).toBe('999999999');
    expect(rng.calls()).toBe(3);
  });

  it('maps every accepted block uniformly (value modulo 1e9 of an unbiased draw)', () => {
    expect(generateSecurityCode('0000001', fakeRandomBytes([3_000_000_007]).randomBytes)).toBe(
      '000000007',
    );
  });

  it('retries when the code equals dNumDoc compared zero-padded', () => {
    const rng = fakeRandomBytes([1234567, 7654321]);
    // dNumDoc 1234567 padded to 9 digits is 001234567 = the first draw.
    expect(generateSecurityCode('1234567', rng.randomBytes)).toBe('007654321');
    expect(rng.calls()).toBe(2);
  });

  it('accepts dNumDoc given as a number or unpadded string', () => {
    expect(generateSecurityCode(5, fakeRandomBytes([5, 6]).randomBytes)).toBe('000000006');
    expect(generateSecurityCode('5', fakeRandomBytes([5, 6]).randomBytes)).toBe('000000006');
  });

  it('rejects a dNumDoc that is not 1..9999999', () => {
    for (const bad of ['', 'abc', '0', '10000000', -1, 1.5, '00000001']) {
      expect(() => generateSecurityCode(bad)).toThrow(InvalidDocumentNumberError);
    }
  });
});
