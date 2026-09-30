import { createRuc } from '../../fiscal-config/domain/ruc.js';

/** A CDC part (or the whole CDC) is malformed; `field` names the offender. */
export class InvalidCdcError extends Error {
  constructor(
    readonly field: string,
    reason: string,
  ) {
    super(`Invalid CDC ${field}: ${reason}`);
    this.name = 'InvalidCdcError';
  }
}

/**
 * Components of the 44-digit CDC (Manual Técnico v150, §10.1). Numeric-padded
 * fields are strings so leading zeros survive; short values are left-padded.
 */
export interface CdcParts {
  /** iTiDE (C002), 1..8, two digits. */
  readonly documentType: string;
  /** dRucEm without check digit (D101), 3-8 digits, padded to 8. */
  readonly rucBase: string;
  /** dDVEmi (D102), modulo 11 of the RUC. */
  readonly rucDv: number;
  /** dEst (C005), 001..999. */
  readonly establishment: string;
  /** dPunExp (C006), 001..999. */
  readonly point: string;
  /** dNumDoc (C007), 0000001..9999999. */
  readonly documentNumber: string;
  /** iTipCont (D013): 1 natural person, 2 legal entity. */
  readonly taxpayerType: 1 | 2;
  /** dFeEmiDE calendar date, `YYYY-MM-DD`. */
  readonly issueDate: string;
  /** iTipEmi (B002): 1 normal, 2 contingency. */
  readonly emissionType: 1 | 2;
  /** dCodSeg (A003), 000000001..999999999, different from dNumDoc. */
  readonly securityCode: string;
}

const CDC_PATTERN = /^\d{44}$/;
const ISSUE_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

function digits(field: string, value: string, min: number, max: number, width: number): string {
  if (typeof value !== 'string' || !/^\d+$/.test(value) || value.length > width) {
    throw new InvalidCdcError(field, `expected up to ${String(width)} digits`);
  }
  const numeric = Number(value);
  if (numeric < min || numeric > max) {
    throw new InvalidCdcError(field, `must be ${String(min)}..${String(max)}`);
  }
  return value.padStart(width, '0');
}

function oneOf<T extends number>(field: string, value: number, allowed: readonly T[]): T {
  const match = allowed.find((candidate) => candidate === value);
  if (match === undefined) throw new InvalidCdcError(field, `must be one of ${allowed.join(', ')}`);
  return match;
}

function compactDate(value: string): string {
  const match = ISSUE_DATE_PATTERN.exec(value);
  if (!match) throw new InvalidCdcError('issueDate', 'expected YYYY-MM-DD');
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    year < 1 ||
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new InvalidCdcError('issueDate', 'not a real calendar date');
  }
  return `${match[1]}${match[2]}${match[3]}`;
}

/**
 * CDC check digit (MT v150 §10.2, SET modulo 11): weights cycle 2..11 from the
 * rightmost of the 43 base digits; `dv = remainder > 1 ? 11 - remainder : 0`.
 * Verified against the MT §10.1 example.
 */
export function computeCdcCheckDigit(base: string): number {
  if (!/^\d{43}$/.test(base)) throw new InvalidCdcError('base', 'expected 43 digits');
  let sum = 0;
  for (let position = 0; position < base.length; position += 1) {
    sum += Number(base[base.length - 1 - position]) * (2 + (position % 10));
  }
  const remainder = sum % 11;
  return remainder > 1 ? 11 - remainder : 0;
}

/** Builds the 44-digit CDC, validating every part. @throws InvalidCdcError */
export function buildCdc(parts: CdcParts): string {
  const documentType = digits('documentType', parts.documentType, 1, 8, 2);
  const rucBase = digits('rucBase', parts.rucBase, 0, 99_999_999, 8);
  try {
    createRuc(rucBase, parts.rucDv);
  } catch {
    throw new InvalidCdcError('rucDv', 'does not match the RUC modulo-11 check digit');
  }
  const establishment = digits('establishment', parts.establishment, 1, 999, 3);
  const point = digits('point', parts.point, 1, 999, 3);
  const documentNumber = digits('documentNumber', parts.documentNumber, 1, 9_999_999, 7);
  const taxpayerType = oneOf('taxpayerType', parts.taxpayerType, [1, 2]);
  const issueDate = compactDate(parts.issueDate);
  const emissionType = oneOf('emissionType', parts.emissionType, [1, 2]);
  const securityCode = digits('securityCode', parts.securityCode, 1, 999_999_999, 9);
  if (Number(securityCode) === Number(documentNumber)) {
    throw new InvalidCdcError('securityCode', 'must differ from dNumDoc');
  }

  const base = [
    documentType,
    rucBase,
    String(parts.rucDv),
    establishment,
    point,
    documentNumber,
    String(taxpayerType),
    issueDate,
    String(emissionType),
    securityCode,
  ].join('');
  return `${base}${String(computeCdcCheckDigit(base))}`;
}

/** Splits a CDC into its parts, validating length, check digit and every field. */
export function parseCdc(cdc: string): CdcParts {
  if (!CDC_PATTERN.test(cdc)) throw new InvalidCdcError('cdc', 'expected exactly 44 digits');
  const parts: CdcParts = {
    documentType: cdc.slice(0, 2),
    rucBase: cdc.slice(2, 10),
    rucDv: Number(cdc[10]),
    establishment: cdc.slice(11, 14),
    point: cdc.slice(14, 17),
    documentNumber: cdc.slice(17, 24),
    taxpayerType: Number(cdc[24]) as 1 | 2,
    issueDate: `${cdc.slice(25, 29)}-${cdc.slice(29, 31)}-${cdc.slice(31, 33)}`,
    emissionType: Number(cdc[33]) as 1 | 2,
    securityCode: cdc.slice(34, 43),
  };
  if (computeCdcCheckDigit(cdc.slice(0, 43)) !== Number(cdc[43])) {
    throw new InvalidCdcError('cdc', 'check digit mismatch (SET modulo 11)');
  }
  buildCdc(parts);
  return parts;
}
