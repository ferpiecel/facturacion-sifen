import { describe, expect, it } from 'vitest';
import { parseRucCacheTtl } from './ruc-cache-ttl.js';

describe('parseRucCacheTtl', () => {
  it('defaults to one day', () => {
    expect(parseRucCacheTtl(undefined)).toBe(86400);
    expect(parseRucCacheTtl('')).toBe(86400);
  });
  it('accepts 0 (cache off) up to one week', () => {
    expect(parseRucCacheTtl('0')).toBe(0);
    expect(parseRucCacheTtl('604800')).toBe(604800);
  });
  it.each(['-1', '604801', '1.5', 'abc', '10s', ' 5'])('rejects %s', (value) => {
    expect(() => parseRucCacheTtl(value)).toThrow(/RUC_CACHE_TTL_SECONDS/);
  });
});
