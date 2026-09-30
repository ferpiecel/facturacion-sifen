import { describe, expect, it } from 'vitest';
import {
  DocumentNumberExhaustedError,
  InvalidSeriesError,
  nextSeries,
  SeriesExhaustedError,
} from '../src/series.js';

/** Spec: HU-E4-02 (rule 1110). Series AA..ZZ, ASCII letters only (no Ñ). */
describe('nextSeries', () => {
  it('opens the first series as AA when none is active', () => {
    expect(nextSeries(null)).toBe('AA');
  });

  it('advances the last letter, then carries into the first', () => {
    expect(nextSeries('AA')).toBe('AB');
    expect(nextSeries('AY')).toBe('AZ');
    expect(nextSeries('AZ')).toBe('BA');
    expect(nextSeries('YZ')).toBe('ZA');
    expect(nextSeries('ZY')).toBe('ZZ');
  });

  it('walks all 676 series without repeats', () => {
    const seen = new Set<string>();
    let current: string | null = null;
    for (let i = 0; i < 676; i += 1) {
      current = nextSeries(current);
      seen.add(current);
    }
    expect(seen.size).toBe(676);
    expect(current).toBe('ZZ');
  });

  it('throws a typed exhaustion error after ZZ', () => {
    expect(() => nextSeries('ZZ')).toThrow(SeriesExhaustedError);
    expect(() => nextSeries('ZZ')).toThrow(DocumentNumberExhaustedError);
  });

  it.each(['ÑA', 'AÑ', 'ña', 'aa', 'A', 'AAA', '', '1A', 'A-'])('rejects %j', (value) => {
    expect(() => nextSeries(value)).toThrow(InvalidSeriesError);
  });
});
