/** Thrown when a timbrado fails format or validity validation. */
export class InvalidTimbradoError extends Error {
  constructor(reason: string) {
    super(`Invalid timbrado: ${reason}`);
    this.name = 'InvalidTimbradoError';
  }
}

// dNumTim (MT §C004 / XSD tdNumTim): exactly 8 digits, not all zeros.
const TIMBRADO_NUMBER_PATTERN = /^(?!0{8}$)\d{8}$/;
// dFeIniT (MT §C008 / XSD tdFeIniT): "AAAA-MM-DD", minInclusive 2018-05-01.
const VALIDITY_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MIN_VALIDITY_START = '2018-05-01';

export interface Timbrado {
  /** dNumTim */
  readonly number: string;
  /** dFeIniT ("AAAA-MM-DD") */
  readonly validityStart: string;
  /** dFeFinT ("AAAA-MM-DD"), optional */
  readonly validityEnd: string | null;
}

export interface CreateTimbradoInput {
  number: string;
  validityStart: string;
  validityEnd?: string | null;
}

/**
 * Builds a {@link Timbrado} (HU-E2-02): validates the 8-digit number
 * (dNumTim), the validity start date against the MT's minimum
 * (2018-05-01, dFeIniT) and, when given, that the validity end (dFeFinT)
 * is not before the start.
 */
export function createTimbrado(input: CreateTimbradoInput): Timbrado {
  const number = input.number.trim();
  if (!TIMBRADO_NUMBER_PATTERN.test(number)) {
    throw new InvalidTimbradoError(
      `number "${input.number}" must be 8 digits and not all zeros (dNumTim)`,
    );
  }

  const validityStart = requireValidDate(input.validityStart, 'validityStart (dFeIniT)');
  if (validityStart < MIN_VALIDITY_START) {
    throw new InvalidTimbradoError(
      `validityStart "${validityStart}" must be on or after ${MIN_VALIDITY_START} (dFeIniT)`,
    );
  }

  const trimmedEnd = input.validityEnd?.trim();
  const validityEnd =
    trimmedEnd === undefined || trimmedEnd === ''
      ? null
      : requireValidDate(trimmedEnd, 'validityEnd (dFeFinT)');
  if (validityEnd !== null && validityEnd < validityStart) {
    throw new InvalidTimbradoError(
      `validityEnd "${validityEnd}" must not be before validityStart "${validityStart}" (dFeFinT)`,
    );
  }

  return { number, validityStart, validityEnd };
}

function requireValidDate(raw: string, field: string): string {
  const value = raw.trim();
  if (!VALIDITY_DATE_PATTERN.test(value) || !isCalendarDate(value)) {
    throw new InvalidTimbradoError(`${field} "${raw}" must be a valid "AAAA-MM-DD" date`);
  }
  return value;
}

/**
 * `Date.parse` silently rolls over impossible days ("2026-02-30" becomes
 * March 2nd), so round-trip the parsed UTC date back to its string form.
 */
function isCalendarDate(value: string): boolean {
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}
