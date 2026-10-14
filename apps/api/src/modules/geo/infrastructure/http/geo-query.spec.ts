import { describe, expect, it } from 'vitest';
import { parseCodeQuery } from './geo-query.js';

describe('parseCodeQuery', () => {
  it('accepts a positive integer in a single query parameter', () => {
    expect(parseCodeQuery('departmentCode', '11')).toBe(11);
  });

  it.each([undefined, '', 'abc', '1.5', '-1', '0', '1e3', ' 1', ['1', '2'], 11, '9999999'])(
    'rejects %j with 400 naming the parameter',
    (raw) => {
      expect(() => parseCodeQuery('districtCode', raw)).toThrow(/districtCode/);
    },
  );
});
