import { describe, expect, it } from 'vitest';
import {
  DEFAULT_VOID_CONFIG,
  parseVoidRequest,
  rangeSize,
  rangesOverlap,
  type VoidRange,
} from './void-rules.js';

const valid = (overrides: Record<string, unknown> = {}) => ({
  timbrado: '12345678',
  establishment: '001',
  expeditionPoint: '002',
  type: 1,
  from: 10,
  to: 20,
  reason: 'Numeración saltada por error',
  ...overrides,
});

const rulesOf = (input: unknown) => {
  const result = parseVoidRequest(input, DEFAULT_VOID_CONFIG);
  return result.ok ? [] : result.errors.map((e) => `${e.field}:${e.rule}`);
};

/** Spec: HU-E8-03. MT v150 11.1.1, 11.5.1 (GEI001 to GEI008) and 11.6.2 (4067, 4068). */
describe('parseVoidRequest', () => {
  it('accepts a valid range and normalises it', () => {
    expect(parseVoidRequest(valid(), DEFAULT_VOID_CONFIG)).toEqual({
      ok: true,
      range: {
        timbrado: '12345678',
        establishment: '001',
        point: '002',
        from: 10,
        to: 20,
        type: 1,
      },
      reason: 'Numeración saltada por error',
    });
  });

  it('keeps a series of two capital letters', () => {
    const result = parseVoidRequest(valid({ series: 'AB' }), DEFAULT_VOID_CONFIG);
    expect(result.ok && result.range.series).toBe('AB');
  });

  it('accepts a range of exactly 1000 numbers and refuses 1001 (4067)', () => {
    expect(rulesOf(valid({ from: 1, to: 1000 }))).toEqual([]);
    expect(rulesOf(valid({ from: 1, to: 1001 }))).toEqual(['to:range-too-large']);
  });

  it('accepts a single number by default, and refuses it when configured to follow 4068 literally', () => {
    expect(rulesOf(valid({ from: 5, to: 5 }))).toEqual([]);
    const strict = parseVoidRequest(valid({ from: 5, to: 5 }), {
      ...DEFAULT_VOID_CONFIG,
      allowSingleNumber: false,
    });
    expect(strict.ok).toBe(false);
  });

  it('refuses an end before the start (4068)', () => {
    expect(rulesOf(valid({ from: 20, to: 10 }))).toEqual(['to:range-end-before-start']);
  });

  it.each([
    ['timbrado', { timbrado: '1234' }, 'timbrado:invalid-timbrado'],
    ['timbrado type', { timbrado: 12345678 }, 'timbrado:invalid-timbrado'],
    ['establishment', { establishment: '1' }, 'establishment:invalid-establishment'],
    ['point', { expeditionPoint: 'abc' }, 'expeditionPoint:invalid-expedition-point'],
    ['type', { type: 9 }, 'type:invalid-document-type'],
    ['type text', { type: '1' }, 'type:invalid-document-type'],
    ['series', { series: 'a1' }, 'series:invalid-series'],
    ['from zero', { from: 0 }, 'from:invalid-number'],
    ['from fraction', { from: 1.5 }, 'from:invalid-number'],
    ['to too big', { to: 10_000_000 }, 'to:invalid-number'],
    ['reason short', { reason: 'abcd' }, 'reason:reason-length'],
    ['reason long', { reason: 'x'.repeat(151) }, 'reason:reason-length'],
    ['reason missing', { reason: undefined }, 'reason:reason-length'],
  ])('refuses an invalid %s', (_name, overrides, expected) => {
    expect(rulesOf(valid(overrides))).toContain(expected);
  });

  it('reports every invalid field at once', () => {
    expect(rulesOf({})).toEqual(
      expect.arrayContaining([
        'timbrado:invalid-timbrado',
        'establishment:invalid-establishment',
        'expeditionPoint:invalid-expedition-point',
        'type:invalid-document-type',
        'from:invalid-number',
        'to:invalid-number',
        'reason:reason-length',
      ]),
    );
    expect(rulesOf('not an object')).not.toEqual([]);
  });

  it('follows a configured reason length', () => {
    const config = { ...DEFAULT_VOID_CONFIG, reasonMaxLength: 500 };
    expect(parseVoidRequest(valid({ reason: 'x'.repeat(500) }), config).ok).toBe(true);
  });
});

describe('rangeSize and rangesOverlap', () => {
  const range = (from: number, to: number, overrides: Partial<VoidRange> = {}): VoidRange => ({
    timbrado: '12345678',
    establishment: '001',
    point: '002',
    type: 1,
    from,
    to,
    ...overrides,
  });

  it('counts both ends', () => {
    expect(rangeSize(range(5, 5))).toBe(1);
    expect(rangeSize(range(1, 1000))).toBe(1000);
  });

  it('overlaps when the numbers share one, in the same point, type and series', () => {
    expect(rangesOverlap(range(1, 10), range(10, 20))).toBe(true);
    expect(rangesOverlap(range(1, 10), range(11, 20))).toBe(false);
    expect(rangesOverlap(range(5, 6), range(1, 10))).toBe(true);
  });

  it('never overlaps across timbrado, establishment, point, type or series', () => {
    const base = range(1, 10);
    expect(rangesOverlap(base, range(1, 10, { timbrado: '87654321' }))).toBe(false);
    expect(rangesOverlap(base, range(1, 10, { establishment: '002' }))).toBe(false);
    expect(rangesOverlap(base, range(1, 10, { point: '003' }))).toBe(false);
    expect(rangesOverlap(base, range(1, 10, { type: 5 }))).toBe(false);
    expect(rangesOverlap(base, range(1, 10, { series: 'AB' }))).toBe(false);
  });
});
