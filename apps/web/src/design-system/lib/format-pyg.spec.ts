import { describe, expect, it } from 'vitest';

import { formatPYG } from './format-pyg';

describe('formatPYG', () => {
  it.each([
    [1_250_000, '₲ 1.250.000'],
    [1_000, '₲ 1.000'],
    [999, '₲ 999'],
    [0, '₲ 0'],
    [-650_000, '-₲ 650.000'],
    [12.6, '₲ 13'],
    [-0.4, '₲ 0'],
    [1_234_567_890_123, '₲ 1.234.567.890.123'],
  ])('formats %d as "%s"', (amount, expected) => {
    expect(formatPYG(amount)).toBe(expected);
  });

  it('rejects non-finite amounts', () => {
    expect(() => formatPYG(Number.NaN)).toThrow(RangeError);
    expect(() => formatPYG(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });
});
