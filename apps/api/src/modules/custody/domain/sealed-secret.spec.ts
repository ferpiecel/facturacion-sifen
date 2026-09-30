import { describe, expect, it } from 'vitest';
import { decodeCanonicalBase64 } from './sealed-secret.js';

describe('decodeCanonicalBase64', () => {
  it('decodes standard padded base64', () => {
    expect(decodeCanonicalBase64('AAE=').equals(Buffer.from([0, 1]))).toBe(true);
    expect(decodeCanonicalBase64('')).toHaveLength(0);
  });

  it.each(['AB==', 'AAF=', 'AA E=', 'AAE', '-_8=', 'AAE=\n', 'AAE=AAE='])(
    'rejects the non-canonical encoding %j',
    (value) => {
      expect(() => decodeCanonicalBase64(value)).toThrow(TypeError);
    },
  );
});
