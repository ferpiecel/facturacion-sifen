import { describe, expect, it } from 'vitest';
import {
  RECOVERY_CODE_COUNT,
  findRecoveryCode,
  generateRecoveryCodes,
  hashRecoveryCode,
} from './recovery-codes.js';

describe('recovery codes', () => {
  it('issues ten distinct codes of 80 bits in groups of four', () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(RECOVERY_CODE_COUNT);
    expect(RECOVERY_CODE_COUNT).toBe(10);
    expect(new Set(codes).size).toBe(10);
    for (const code of codes) {
      expect(code).toMatch(/^[a-z2-7]{4}(-[a-z2-7]{4}){3}$/);
    }
  });

  it('hashes to a 64-character hex digest, never the code itself', () => {
    const [code] = generateRecoveryCodes();
    const hash = hashRecoveryCode(code);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain(code);
  });

  it('ignores case, dashes and spaces when hashing', () => {
    expect(hashRecoveryCode('ABCD-efgh-2345-6727')).toBe(hashRecoveryCode(' abcd efgh 2345 6727 '));
    expect(hashRecoveryCode('abcdefgh23456727')).toBe(hashRecoveryCode('abcd-efgh-2345-6727'));
  });

  it('finds the index of a stored hash and nothing for an unknown code', () => {
    const codes = generateRecoveryCodes();
    const hashes = codes.map(hashRecoveryCode);
    expect(findRecoveryCode(codes[3], hashes)).toBe(hashes[3]);
    expect(findRecoveryCode('aaaa-aaaa-aaaa-aaaa', hashes)).toBeNull();
    expect(findRecoveryCode('not a code', hashes)).toBeNull();
  });
});
