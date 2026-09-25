/**
 * Thrown when a RUC base or a full "<base>-<dv>" string fails format or
 * check-digit validation.
 */
export class InvalidRucError extends Error {
  constructor(reason: string, raw: string) {
    super(`Invalid RUC "${raw}": ${reason}`);
    this.name = 'InvalidRucError';
  }
}

/**
 * dRucEm / dDVEmi (Manual Técnico v150, §D2, fields D101-D102): the SET RUC
 * base (without the check digit) is 3 to 8 digits; the check digit (`dv`)
 * is a single digit computed with the SET modulo-11 algorithm.
 */
export interface Ruc {
  readonly base: string;
  readonly dv: number;
}

const RUC_BASE_PATTERN = /^\d{3,8}$/;
const RUC_FORMAT_PATTERN = /^(\d{3,8})-(\d)$/;

/**
 * SET modulo-11 check digit: weights cycle 2..11 starting from the
 * rightmost digit, `remainder = sum % 11`, `dv = remainder > 1 ? 11 -
 * remainder : 0`. Verified against the PO's real RUC 4490207-7.
 */
export function computeRucCheckDigit(base: string): number {
  if (!RUC_BASE_PATTERN.test(base)) {
    throw new InvalidRucError('base must be 3 to 8 digits', base);
  }

  let sum = 0;
  for (let position = 0; position < base.length; position += 1) {
    const digit = Number(base[base.length - 1 - position]);
    const weight = 2 + (position % 10);
    sum += digit * weight;
  }

  const remainder = sum % 11;
  return remainder > 1 ? 11 - remainder : 0;
}

/** Builds a {@link Ruc} from its already-split parts, validating the check digit. */
export function createRuc(base: string, dv: number): Ruc {
  const expected = computeRucCheckDigit(base);
  if (dv !== expected) {
    throw new InvalidRucError(
      `check digit must be ${expected} (SET modulo-11), got ${dv}`,
      `${base}-${dv}`,
    );
  }
  return { base, dv };
}

/** Parses `"<3-8 digits>-<check digit>"` (e.g. `"4490207-7"`) into a {@link Ruc}. */
export function parseRuc(raw: string): Ruc {
  const match = RUC_FORMAT_PATTERN.exec(raw);
  if (!match) {
    throw new InvalidRucError('expected format "<3-8 digits>-<check digit>"', raw);
  }

  const [, base, dvRaw] = match;
  return createRuc(base as string, Number(dvRaw));
}

/** Formats a {@link Ruc} back to `"<base>-<dv>"`. */
export function formatRuc(ruc: Ruc): string {
  return `${ruc.base}-${ruc.dv}`;
}
