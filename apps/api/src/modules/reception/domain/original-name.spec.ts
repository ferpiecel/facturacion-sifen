import { describe, expect, it } from 'vitest';
import { sanitizeOriginalName } from './original-name.js';

describe('sanitizeOriginalName', () => {
  it('strips NUL, control characters and bidi overrides', () => {
    expect(sanitizeOriginalName('a\u202e.pdf\u0000')).toBe('a.pdf');
    expect(sanitizeOriginalName('f\u0007o\r\no\u200b.xml\u2066')).toBe('foo.xml');
  });

  it('keeps the last path segment, ordinary unicode and a bounded length', () => {
    expect(sanitizeOriginalName('C:\\tmp\\factura ñ.xml')).toBe('factura ñ.xml');
    expect(sanitizeOriginalName('x'.repeat(400))).toHaveLength(255);
  });

  it('is null when nothing printable is left', () => {
    expect(sanitizeOriginalName('\u0000\u202e')).toBeNull();
    expect(sanitizeOriginalName(undefined)).toBeNull();
  });
});
