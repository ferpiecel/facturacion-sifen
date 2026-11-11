import { describe, expect, it } from 'vitest';
import { matchReceiver } from './receiver-match.js';

const TENANT = { rucBase: '4490207', dv: 7 };

describe('matchReceiver', () => {
  it('matches base and check digit in "<base>-<dv>" form', () => {
    expect(matchReceiver('4490207-7', TENANT)).toBe('match');
  });

  it('tolerates spaces, dots and leading zeros', () => {
    expect(matchReceiver(' 04.490.207 - 7 ', TENANT)).toBe('match');
  });

  it('matches by base alone when the receiver has no check digit', () => {
    expect(matchReceiver('4490207', TENANT)).toBe('match');
  });

  it('mismatches a different base', () => {
    expect(matchReceiver('80012345-6', TENANT)).toBe('mismatch');
  });

  it('mismatches the same base with a different check digit', () => {
    expect(matchReceiver('4490207-1', TENANT)).toBe('mismatch');
  });

  it('is unknown for missing, blank or unparseable receivers', () => {
    expect(matchReceiver(null, TENANT)).toBe('unknown');
    expect(matchReceiver('   ', TENANT)).toBe('unknown');
    expect(matchReceiver('sin ruc', TENANT)).toBe('unknown');
    expect(matchReceiver('1-2-3', TENANT)).toBe('unknown');
  });

  it('formats the tenant side too', () => {
    expect(matchReceiver('80012345-6', { rucBase: '080012345', dv: 6 })).toBe('match');
  });
});
