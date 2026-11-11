import {
  computeCdcCheckDigit,
  InvalidCdcError,
  parseCdc,
  type CdcParts,
} from '../../emission/domain/cdc.js';

export type CdcReferenceErrorCode = 'not-found' | 'check-digit-mismatch' | 'invalid-structure';

/** A CDC could not be extracted from the input or failed validation; `code` is stable. */
export class CdcReferenceError extends Error {
  constructor(
    readonly code: CdcReferenceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'CdcReferenceError';
  }
}

/** A validated CDC (44 digits, SET modulo-11 check digit, well-formed fields). */
export interface CdcReference {
  readonly value: string;
  readonly parts: Readonly<CdcParts>;
}

const QR_ID = /[?&]Id=(\d{44})(?!\d)/;
const PLAIN = /(?<!\d)\d{44}(?!\d)/;

/**
 * Pulls the 44-digit CDC out of free text: a bare CDC or the `Id=` parameter of a KuDE QR URL.
 * Does not validate the check digit.
 * @throws CdcReferenceError `not-found`
 */
export function extractCdc(text: string): string {
  const trimmed = text.trim();
  const fromUrl = QR_ID.exec(trimmed);
  if (fromUrl?.[1] !== undefined) return fromUrl[1];
  const plain = PLAIN.exec(trimmed);
  if (plain) return plain[0];
  throw new CdcReferenceError('not-found', 'no 44-digit CDC found in the input');
}

/**
 * Extracts and validates a CDC.
 * @throws CdcReferenceError `not-found`, `check-digit-mismatch` or `invalid-structure`
 */
export function createCdcReference(text: string): CdcReference {
  const value = extractCdc(text);
  if (computeCdcCheckDigit(value.slice(0, 43)) !== Number(value[43])) {
    throw new CdcReferenceError('check-digit-mismatch', 'CDC check digit does not match');
  }
  try {
    return Object.freeze({ value, parts: Object.freeze(parseCdc(value)) });
  } catch (error) {
    if (error instanceof InvalidCdcError) {
      throw new CdcReferenceError('invalid-structure', error.message);
    }
    throw error;
  }
}
