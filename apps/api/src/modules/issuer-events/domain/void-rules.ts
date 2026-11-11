/**
 * Rules for voiding a range of numbers (HU-E8-03, "inutilización"). Pure: shape and size checks and range
 * arithmetic. Rules that need the tenant's data (documents in the range, earlier voidings) live in the use case.
 * Sources: MT v150 11.1.1, 11.5.1 (GEI001 to GEI008) and 11.6.2 (4067, 4068).
 */

export interface VoidConfig {
  /** MT v150 11.6.2, 4067: at most 1000 numbers in a range. */
  readonly maxRangeSize: number;
  /**
   * `mOtEve` of a voiding: MT 11.1.1 says free text of up to 150 characters, the field tables say 500. The
   * stricter value is kept until the test environment settles it (T0 of the feature document).
   */
  readonly reasonMaxLength: number;
  /**
   * MT 11.6.2, 4068, reads "the end of the range must be greater than the start", but the xmlgen library and
   * the plan accept one number (`from = to`). Allowed until the Prevalidador says otherwise (T0).
   */
  readonly allowSingleNumber: boolean;
}

export const DEFAULT_VOID_CONFIG: VoidConfig = {
  maxRangeSize: 1000,
  reasonMaxLength: 150,
  allowSingleNumber: true,
};

/** The stored shape of a voiding (`issuer_events.void_range`), as the XML builder reads it. */
export interface VoidRange {
  readonly timbrado: string;
  readonly establishment: string;
  readonly point: string;
  readonly from: number;
  readonly to: number;
  /** `iTiDE`. */
  readonly type: number;
  readonly series?: string;
}

export interface VoidFieldError {
  field: string;
  rule: string;
  message: string;
  /** The SIFEN code of the same rule, when the manual defines one. */
  sifenCode?: string;
}

export type VoidParseResult =
  { ok: true; range: VoidRange; reason: string } | { ok: false; errors: VoidFieldError[] };

const MAX_NUMBER = 9_999_999; // dNumIn and dNumFin have 7 digits
const DOCUMENT_TYPES = [1, 2, 3, 4, 5, 6, 7, 8];

const isNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MAX_NUMBER;

/** Numbers in the range, both ends included. */
export function rangeSize(range: Pick<VoidRange, 'from' | 'to'>): number {
  return range.to - range.from + 1;
}

/** Whether two ranges of the same timbrado, establishment, point, type and series share a number. */
export function rangesOverlap(a: VoidRange, b: VoidRange): boolean {
  return (
    a.timbrado === b.timbrado &&
    a.establishment === b.establishment &&
    a.point === b.point &&
    a.type === b.type &&
    (a.series ?? '') === (b.series ?? '') &&
    a.from <= b.to &&
    b.from <= a.to
  );
}

/** Validates the body of a voiding request (GEI002 to GEI008) and returns the range as it is stored. */
export function parseVoidRequest(input: unknown, config: VoidConfig): VoidParseResult {
  const body = (typeof input === 'object' && input !== null ? input : {}) as Record<
    string,
    unknown
  >;
  const errors: VoidFieldError[] = [];
  const fail = (field: string, rule: string, message: string, sifenCode?: string) =>
    errors.push({ field, rule, message, ...(sifenCode ? { sifenCode } : {}) });
  const digits = (value: unknown, length: number): value is string =>
    typeof value === 'string' && new RegExp(`^[0-9]{${String(length)}}$`).test(value);

  if (!digits(body.timbrado, 8)) {
    fail('timbrado', 'invalid-timbrado', 'The timbrado number has 8 digits');
  }
  if (!digits(body.establishment, 3)) {
    fail('establishment', 'invalid-establishment', 'The establishment code has 3 digits');
  }
  if (!digits(body.expeditionPoint, 3)) {
    fail('expeditionPoint', 'invalid-expedition-point', 'The expedition point code has 3 digits');
  }
  if (typeof body.type !== 'number' || !DOCUMENT_TYPES.includes(body.type)) {
    fail('type', 'invalid-document-type', 'The document type (iTiDE) is 1 to 8');
  }
  if (
    body.series !== undefined &&
    (typeof body.series !== 'string' || !/^[A-Z]{2}$/.test(body.series))
  ) {
    fail('series', 'invalid-series', 'The series has two capital letters');
  }
  if (!isNumber(body.from)) {
    fail('from', 'invalid-number', 'The first number is an integer from 1 to 9999999');
  }
  if (!isNumber(body.to)) {
    fail('to', 'invalid-number', 'The last number is an integer from 1 to 9999999');
  }
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  if (reason.length < 5 || reason.length > config.reasonMaxLength) {
    fail(
      'reason',
      'reason-length',
      `The reason has 5 to ${String(config.reasonMaxLength)} characters`,
    );
  }

  if (isNumber(body.from) && isNumber(body.to)) {
    const size = body.to - body.from + 1;
    if (size < 1 || (size === 1 && !config.allowSingleNumber)) {
      fail('to', 'range-end-before-start', 'The last number must follow the first', '4068');
    } else if (size > config.maxRangeSize) {
      fail(
        'to',
        'range-too-large',
        `A range has at most ${String(config.maxRangeSize)} numbers`,
        '4067',
      );
    }
  }
  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    reason,
    range: {
      timbrado: body.timbrado as string,
      establishment: body.establishment as string,
      point: body.expeditionPoint as string,
      from: body.from as number,
      to: body.to as number,
      type: body.type as number,
      ...(body.series === undefined ? {} : { series: body.series as string }),
    },
  };
}
