import { describe, expect, it } from 'vitest';
import { extractSubjectRuc } from './subject-ruc.js';

describe('extractSubjectRuc (HU-E3-01, §8.7)', () => {
  it('reads a serialNumber of the exact form RUCXXXXXXXX-X', () => {
    expect(extractSubjectRuc(['RUC80000005-6'])).toEqual({ base: '80000005', dv: 6 });
  });

  it('ignores serialNumbers that are not a RUC and keeps the one that is', () => {
    expect(extractSubjectRuc(['CI1234567', 'RUC4490207-7'])).toEqual({ base: '4490207', dv: 7 });
  });

  it('accepts the same RUC more than once', () => {
    expect(extractSubjectRuc(['RUC80000005-6', 'RUC80000005-6'])).toEqual({
      base: '80000005',
      dv: 6,
    });
  });

  it.each([
    ['nothing', []],
    ['a CI instead of a RUC', ['CI1234567']],
    ['a RUC without the RUC prefix', ['80000005-6']],
    ['a wrong check digit', ['RUC80000005-5']],
    ['trailing text', ['RUC80000005-6@gmail.com']],
    ['leading text', ['xRUC80000005-6']],
    ['surrounding whitespace', [' RUC80000005-6']],
    ['a lowercase prefix', ['ruc80000005-6']],
    ['two different RUCs', ['RUC80000005-6', 'RUC4490207-7']],
  ])('returns null for %s', (_case, serialNumbers: string[]) => {
    expect(extractSubjectRuc(serialNumbers)).toBeNull();
  });
});
