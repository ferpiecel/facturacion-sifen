import { describe, expect, it } from 'vitest';
import { decodeCanonicalBase64, encodeAad } from './sealed-secret.js';

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

describe('encodeAad label (HU-E2-03)', () => {
  const base = { tenantId: 't', kind: 'csc', environment: 'test', version: 1 } as const;

  it('keeps the canonical encoding when no label is given', () => {
    expect(encodeAad(base).toString()).toBe('[1,"t","csc","test",1]');
  });

  it('binds the label into the AAD', () => {
    expect(encodeAad({ ...base, label: '0001' }).toString()).toBe('[1,"t","csc","test",1,"0001"]');
    expect(encodeAad({ ...base, label: '0001' })).not.toEqual(
      encodeAad({ ...base, label: '0002' }),
    );
  });
});
