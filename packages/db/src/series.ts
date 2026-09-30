/** Series letters: ASCII A-Z only. The Spanish letter Ñ is not part of the alphabet (rule 1110). */
const SERIES_PATTERN = /^[A-Z]{2}$/;
const FIRST_SERIES = 'AA';
const LAST_SERIES = 'ZZ';

/** Every series (AA..ZZ) has already been used up. */
export class DocumentNumberExhaustedError extends Error {
  constructor(message = 'dNumDoc exhausted: the sequence already issued 9999999') {
    super(message);
    this.name = 'DocumentNumberExhaustedError';
  }
}

/** Series ZZ already issued 9999999: there is no next series. */
export class SeriesExhaustedError extends DocumentNumberExhaustedError {
  constructor() {
    super('dSerieNum exhausted: series ZZ already issued 9999999');
    this.name = 'SeriesExhaustedError';
  }
}

/** A series is not two uppercase ASCII letters (Ñ is rejected). */
export class InvalidSeriesError extends Error {
  constructor(series: string) {
    super(`invalid dSerieNum series: ${JSON.stringify(series)} (expected two letters A-Z, no Ñ)`);
    this.name = 'InvalidSeriesError';
  }
}

export function isValidSeries(series: string): boolean {
  return SERIES_PATTERN.test(series);
}

/**
 * Next series after `current` in AA, AB..AZ, BA..ZZ order. `null` means no
 * series is active yet (numbering started without one), so the first is `AA`.
 *
 * @throws InvalidSeriesError when `current` is not two letters A-Z.
 * @throws SeriesExhaustedError after `ZZ`.
 */
export function nextSeries(current: string | null): string {
  if (current === null) {
    return FIRST_SERIES;
  }
  if (!isValidSeries(current)) {
    throw new InvalidSeriesError(current);
  }
  if (current === LAST_SERIES) {
    throw new SeriesExhaustedError();
  }
  const [first, second] = current;
  return second === 'Z'
    ? `${String.fromCharCode(first.charCodeAt(0) + 1)}A`
    : `${first}${String.fromCharCode(second.charCodeAt(0) + 1)}`;
}
