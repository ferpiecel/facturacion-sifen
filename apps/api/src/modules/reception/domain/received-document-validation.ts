import { computeCdcCheckDigit } from '../../emission/domain/cdc.js';
import { Decimal } from '../../emission/domain/decimal.js';
import { computeRucCheckDigit } from '../../fiscal-config/domain/ruc.js';
import { splitRuc } from './receiver-match.js';

/** Stable reason codes, suitable for `needs_review` reasons. */
export type ValidationReason =
  | 'missing_issuer_ruc'
  | 'missing_issuer_legal_name'
  | 'missing_document_number'
  | 'missing_issue_date'
  | 'missing_totals'
  | 'issuer_ruc_invalid_format'
  | 'issuer_ruc_check_digit_mismatch'
  | 'invalid_document_number_format'
  | 'invalid_issue_date'
  | 'cdc_invalid'
  | 'cdc_check_digit_mismatch'
  | 'invalid_amount'
  | 'totals_blocks_sum_mismatch'
  | 'vat5_inconsistent'
  | 'vat10_inconsistent'
  | 'items_sum_mismatch';

/** Amount blocks of a document as decimal strings (never `number`). */
export interface ReceivedTotals {
  readonly exempt: string;
  readonly exonerated: string;
  /** Taxable base without VAT (VAT is included in the price in Paraguay, blocks are separated). */
  readonly taxable5: string;
  readonly taxable10: string;
  readonly vat5: string;
  readonly vat10: string;
  readonly total: string;
}

export interface ReceivedDocumentFields {
  readonly cdc: string | null;
  /** Issuer RUC as `<base>-<dv>` (formatting is tolerated). */
  readonly issuerRuc: string | null;
  readonly issuerLegalName: string | null;
  /** `EEE-PPP-NNNNNNN`. */
  readonly documentNumber: string | null;
  /** `YYYY-MM-DD`. */
  readonly issueDate: string | null;
  readonly totals: ReceivedTotals | null;
  /** Line totals (decimal strings); empty means items were not provided. */
  readonly itemAmounts: readonly string[];
}

export interface ValidationOptions {
  readonly tolerance?: Decimal;
}

/** ADR-0026 `RECEPTION_TOTALS_TOLERANCE` default: 1.00 Gs. */
export const DEFAULT_TOTALS_TOLERANCE: Decimal = parseConstant('1');

const ZERO = parseConstant('0');
const RATE_5 = parseConstant('0.05');
const RATE_10 = parseConstant('0.1');

function parseConstant(text: string): Decimal {
  const parsed = Decimal.parse(text);
  if (!parsed.ok) throw new Error(`invalid decimal constant ${text}`);
  return parsed.value;
}

function near(a: Decimal, b: Decimal, tolerance: Decimal): boolean {
  const diff = a.subtract(b);
  return (diff.isNegative() ? diff.negate() : diff).compare(tolerance) <= 0;
}

function parseAll(values: readonly string[]): Decimal[] | null {
  const out: Decimal[] = [];
  for (const value of values) {
    const parsed = Decimal.parse(value);
    if (!parsed.ok) return null;
    out.push(parsed.value);
  }
  return out;
}

/** Arithmetic identities of a document; never throws on business failures. */
export function validateTotals(
  totals: ReceivedTotals,
  itemAmounts: readonly string[],
  tolerance: Decimal = DEFAULT_TOTALS_TOLERANCE,
): ValidationReason[] {
  const parsed = parseAll([
    totals.exempt,
    totals.exonerated,
    totals.taxable5,
    totals.vat5,
    totals.taxable10,
    totals.vat10,
    totals.total,
  ]);
  const items = parseAll(itemAmounts);
  if (parsed === null || items === null) return ['invalid_amount'];
  const [exempt, exonerated, taxable5, vat5, taxable10, vat10, total] = parsed as [
    Decimal,
    Decimal,
    Decimal,
    Decimal,
    Decimal,
    Decimal,
    Decimal,
  ];
  const reasons: ValidationReason[] = [];
  const blocks = [exempt, exonerated, taxable5, vat5, taxable10, vat10].reduce(
    (acc, value) => acc.add(value),
    ZERO,
  );
  if (!near(blocks, total, tolerance)) reasons.push('totals_blocks_sum_mismatch');
  if (!near(vat5, taxable5.multiply(RATE_5, 'half-even').roundTo(2, 'half-even'), tolerance)) {
    reasons.push('vat5_inconsistent');
  }
  if (!near(vat10, taxable10.multiply(RATE_10, 'half-even').roundTo(2, 'half-even'), tolerance)) {
    reasons.push('vat10_inconsistent');
  }
  if (items.length > 0) {
    const itemsSum = items.reduce((acc, value) => acc.add(value), ZERO);
    if (!near(itemsSum, total, tolerance)) reasons.push('items_sum_mismatch');
  }
  return reasons;
}

const DOCUMENT_NUMBER = /^\d{3}-\d{3}-\d{7}$/;
const ISSUE_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const CDC_44 = /^\d{44}$/;

function isRealDate(value: string): boolean {
  const match = ISSUE_DATE.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    year >= 1 &&
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function blank(value: string | null): boolean {
  return value === null || value.trim() === '';
}

function validateIssuerRuc(raw: string): ValidationReason | null {
  const ruc = splitRuc(raw);
  if (ruc?.dv == null || ruc.base.length < 3 || ruc.base.length > 8) {
    return 'issuer_ruc_invalid_format';
  }
  return computeRucCheckDigit(ruc.base) === ruc.dv ? null : 'issuer_ruc_check_digit_mismatch';
}

function validateCdc(cdc: string): ValidationReason | null {
  if (!CDC_44.test(cdc)) return 'cdc_invalid';
  return computeCdcCheckDigit(cdc.slice(0, 43)) === Number(cdc[43])
    ? null
    : 'cdc_check_digit_mismatch';
}

/**
 * Required fields, RUC and CDC check digits, formats and arithmetic. Returns the reasons in a
 * stable order (empty when everything holds); never throws for business failures.
 */
export function validateReceivedDocument(
  fields: ReceivedDocumentFields,
  options: ValidationOptions = {},
): ValidationReason[] {
  const reasons: ValidationReason[] = [];
  if (blank(fields.issuerRuc)) reasons.push('missing_issuer_ruc');
  if (blank(fields.issuerLegalName)) reasons.push('missing_issuer_legal_name');
  if (blank(fields.documentNumber)) reasons.push('missing_document_number');
  if (blank(fields.issueDate)) reasons.push('missing_issue_date');
  if (fields.totals === null) reasons.push('missing_totals');

  const checks: (ValidationReason | null)[] = [
    fields.issuerRuc !== null && !blank(fields.issuerRuc)
      ? validateIssuerRuc(fields.issuerRuc)
      : null,
    fields.documentNumber !== null &&
    !blank(fields.documentNumber) &&
    !DOCUMENT_NUMBER.test(fields.documentNumber)
      ? 'invalid_document_number_format'
      : null,
    fields.issueDate !== null && !blank(fields.issueDate) && !isRealDate(fields.issueDate)
      ? 'invalid_issue_date'
      : null,
    fields.cdc !== null ? validateCdc(fields.cdc) : null,
  ];
  for (const check of checks) if (check !== null) reasons.push(check);

  if (fields.totals !== null) {
    reasons.push(...validateTotals(fields.totals, fields.itemAmounts, options.tolerance));
  }
  return [...new Set(reasons)];
}
