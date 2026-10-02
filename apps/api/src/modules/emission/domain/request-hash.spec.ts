import { describe, expect, it } from 'vitest';
import { canonicalJson, requestHash } from './request-hash.js';

/** Spec: HU-E5-02 (RF-03). Equal bodies hash equal whatever their key order. */
describe('canonicalJson', () => {
  it('sorts object keys at every depth and keeps array order', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, 1], c: null } })).toBe(
      '{"a":{"c":null,"d":[3,1]},"b":1}',
    );
  });

  it('serializes primitives like JSON', () => {
    expect(canonicalJson('x"y')).toBe('"x\\"y"');
    expect(canonicalJson([true, 1.5, null])).toBe('[true,1.5,null]');
  });

  it('drops undefined object members, as JSON does', () => {
    expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}');
  });
});

describe('requestHash', () => {
  it('is a lowercase sha-256 hex digest', () => {
    expect(requestHash({ a: 1 })).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is independent of key order and sensitive to any value change', () => {
    expect(requestHash({ a: 1, b: [1, 2] })).toBe(requestHash({ b: [1, 2], a: 1 }));
    expect(requestHash({ a: 1, b: [1, 2] })).not.toBe(requestHash({ a: 1, b: [2, 1] }));
    expect(requestHash({ a: 1 })).not.toBe(requestHash({ a: 2 }));
  });
});
