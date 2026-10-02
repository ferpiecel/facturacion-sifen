import { describe, expect, it } from 'vitest';
import { derChildren, DerError, readDerElement, readDerElements } from './der.js';

const bytes = (...values: number[]) => Buffer.from(values);

describe('DER reader bounds (HU-E3-01)', () => {
  it('reads short and long definite lengths', () => {
    expect(readDerElements(bytes(0x04, 0x01, 0xaa, 0x05, 0x00))).toEqual([
      { tag: 0x04, content: bytes(0xaa) },
      { tag: 0x05, content: bytes() },
    ]);
    const long = Buffer.concat([bytes(0x04, 0x81, 0x80), Buffer.alloc(0x80)]);
    expect(readDerElement(long).content).toHaveLength(0x80);
  });

  it.each([
    ['a truncated header', bytes(0x04)],
    ['content past the end', bytes(0x04, 0x02, 0xaa)],
    ['an indefinite length', bytes(0x30, 0x80, 0x00, 0x00)],
    ['a 5-octet length', bytes(0x04, 0x85, 0, 0, 0, 0, 1)],
    ['length octets past the end', bytes(0x04, 0x82, 0x01)],
    ['a high tag number', bytes(0x1f, 0x01, 0x00)],
  ])('rejects %s', (_case, input) => {
    expect(() => readDerElements(input)).toThrow(DerError);
  });

  it('requires exactly one element and constructed parents', () => {
    expect(() => readDerElement(bytes(0x05, 0x00, 0x05, 0x00))).toThrow(DerError);
    expect(() => readDerElement(bytes())).toThrow(DerError);
    expect(() => derChildren({ tag: 0x04, content: bytes() })).toThrow(DerError);
  });
});
