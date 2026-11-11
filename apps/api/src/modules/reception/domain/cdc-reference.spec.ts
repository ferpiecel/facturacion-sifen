import { describe, expect, it } from 'vitest';
import { CdcReferenceError, createCdcReference, extractCdc } from './cdc-reference.js';

// Manual Técnico v150, §10.1 worked example (valid check digit).
const MT_CDC = '01444444017001001001452822017012515873260988';
// Same digits as project A's fixture "0" * 43 + "1": 44 digits, wrong check digit.
const A_CDC = `${'0'.repeat(43)}1`;

describe('extractCdc (ported from project A test_cdc)', () => {
  it('returns a plain 44-digit CDC', () => {
    expect(extractCdc(A_CDC)).toBe(A_CDC);
  });

  it('extracts the CDC from a KuDE QR URL', () => {
    const url = `https://ekuatia.set.gov.py/consultas/qr?nVersion=150&Id=${A_CDC}&dFeEmiDE=abc`;
    expect(extractCdc(url)).toBe(A_CDC);
  });

  it('trims surrounding whitespace', () => {
    expect(extractCdc(`  ${MT_CDC}\n`)).toBe(MT_CDC);
  });

  it('throws not-found for text without a CDC', () => {
    expect(() => extractCdc('esto no tiene ningun cdc')).toThrow(CdcReferenceError);
    expect(() => extractCdc('esto no tiene ningun cdc')).toThrow(
      expect.objectContaining({ code: 'not-found' }),
    );
  });

  it('does not match a shorter number', () => {
    expect(() => extractCdc('12345')).toThrow(expect.objectContaining({ code: 'not-found' }));
  });

  it('does not match a longer digit run', () => {
    expect(() => extractCdc(`${MT_CDC}9`)).toThrow(expect.objectContaining({ code: 'not-found' }));
  });
});

describe('createCdcReference', () => {
  it('builds a value object with the embedded fields', () => {
    const ref = createCdcReference(MT_CDC);
    expect(ref.value).toBe(MT_CDC);
    expect(ref.parts.documentType).toBe('01');
    expect(ref.parts.rucBase).toBe('44444401');
    expect(ref.parts.rucDv).toBe(7);
    expect(ref.parts.establishment).toBe('001');
    expect(ref.parts.documentNumber).toBe('0014528');
    expect(ref.parts.issueDate).toBe('2017-01-25');
    expect(Object.isFrozen(ref)).toBe(true);
  });

  it('accepts a QR URL', () => {
    expect(createCdcReference(`https://x.y/qr?Id=${MT_CDC}&z=1`).value).toBe(MT_CDC);
  });

  it('rejects a wrong check digit', () => {
    expect(() => createCdcReference(A_CDC)).toThrow(
      expect.objectContaining({ code: 'check-digit-mismatch' }),
    );
  });

  it('rejects a CDC with the right check digit but an invalid structure', () => {
    // Valid check digit over document type 99 (outside 1..8).
    const body = `99${MT_CDC.slice(2, 43)}`;
    let check = 0;
    for (let i = 0; i < 43; i += 1) check += Number(body[42 - i]) * (2 + (i % 10));
    const r = check % 11;
    const cdc = `${body}${String(r > 1 ? 11 - r : 0)}`;
    expect(() => createCdcReference(cdc)).toThrow(
      expect.objectContaining({ code: 'invalid-structure' }),
    );
  });
});
