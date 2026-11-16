import {
  InvalidConfidenceError,
  assertConfidence,
  assertFieldConfidences,
  type FieldConfidences,
} from './confidence-policy.js';
import { Decimal } from '../../emission/domain/decimal.js';
import type { ReceivedDocumentFields, ReceivedTotals } from './received-document-validation.js';

export type PaymentCondition = 'cash' | 'credit';
export type VatRate = 0 | 5 | 10;

/** One extracted line; amounts are decimal strings, never `number`. */
export interface ExtractedItem {
  readonly description: string | null;
  readonly productCode: string | null;
  readonly quantity: string | null;
  readonly unitOfMeasure: string | null;
  readonly unitPrice: string | null;
  readonly discount: string | null;
  readonly subtotal: string | null;
  readonly vatRate: VatRate | null;
  readonly taxableBase: string | null;
  readonly vatAmount: string | null;
}

export interface ExtractionResult {
  readonly cdc: string | null;
  readonly issuerRuc: string | null;
  readonly issuerLegalName: string | null;
  readonly documentNumber: string | null;
  readonly issueDate: string | null;
  readonly receiverRuc: string | null;
  readonly paymentCondition: PaymentCondition | null;
  readonly totals: ReceivedTotals | null;
  readonly items: readonly ExtractedItem[];
  readonly fieldConfidences: FieldConfidences;
  readonly overallConfidence: number;
}

export class InvalidExtractionResultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidExtractionResultError';
  }
}

type Raw = Readonly<Record<string, unknown>>;

function isObject(value: unknown): value is Raw {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(path: string, expected: string): never {
  throw new InvalidExtractionResultError(`${path} must be ${expected}`);
}

/** Missing keys are treated as null: the model may omit what it cannot read. */
function text(raw: Raw, key: string, path: string): string | null {
  const value = raw[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') fail(`${path}${key}`, 'a string or null');
  return value;
}

function amount(raw: Raw, key: string, path: string): string | null {
  const value = text(raw, key, path);
  if (value !== null && !Decimal.parse(value).ok) fail(`${path}${key}`, 'a decimal string or null');
  return value;
}

function requiredAmount(raw: Raw, key: string, path: string): string {
  const value = amount(raw, key, path);
  if (value === null) fail(`${path}${key}`, 'a decimal string');
  return value;
}

function parseTotals(value: unknown): ReceivedTotals | null {
  if (value === undefined || value === null) return null;
  if (!isObject(value)) return fail('totals', 'an object or null');
  const p = 'totals.';
  return {
    exempt: requiredAmount(value, 'exempt', p),
    exonerated: requiredAmount(value, 'exonerated', p),
    taxable5: requiredAmount(value, 'taxable5', p),
    taxable10: requiredAmount(value, 'taxable10', p),
    vat5: requiredAmount(value, 'vat5', p),
    vat10: requiredAmount(value, 'vat10', p),
    total: requiredAmount(value, 'total', p),
  };
}

function parseItem(value: unknown, index: number): ExtractedItem {
  const label = `items[${String(index)}]`;
  const p = `${label}.`;
  if (!isObject(value)) return fail(label, 'an object');
  const rate = value['vatRate'];
  if (rate !== undefined && rate !== null && rate !== 0 && rate !== 5 && rate !== 10) {
    fail(`${p}vatRate`, '0, 5, 10 or null');
  }
  return {
    description: text(value, 'description', p),
    productCode: text(value, 'productCode', p),
    quantity: amount(value, 'quantity', p),
    unitOfMeasure: text(value, 'unitOfMeasure', p),
    unitPrice: amount(value, 'unitPrice', p),
    discount: amount(value, 'discount', p),
    subtotal: amount(value, 'subtotal', p),
    vatRate: rate ?? null,
    taxableBase: amount(value, 'taxableBase', p),
    vatAmount: amount(value, 'vatAmount', p),
  };
}

/**
 * Validates the shape of raw extraction data (camelCase keys) and builds an immutable result.
 * Business validity (checksums, arithmetic) is judged separately by the confidence policy.
 *
 * @throws InvalidExtractionResultError naming the offending path.
 */
export function parseExtractionResult(input: unknown): ExtractionResult {
  if (!isObject(input)) return fail('extraction', 'an object');
  const condition = input['paymentCondition'];
  if (
    condition !== undefined &&
    condition !== null &&
    condition !== 'cash' &&
    condition !== 'credit'
  ) {
    fail('paymentCondition', "'cash', 'credit' or null");
  }
  const rawItems = input['items'] ?? [];
  if (!Array.isArray(rawItems)) fail('items', 'an array');
  try {
    const overall: unknown = input['overallConfidence'];
    assertConfidence(overall, 'overallConfidence');
    return Object.freeze({
      cdc: text(input, 'cdc', ''),
      issuerRuc: text(input, 'issuerRuc', ''),
      issuerLegalName: text(input, 'issuerLegalName', ''),
      documentNumber: text(input, 'documentNumber', ''),
      issueDate: text(input, 'issueDate', ''),
      receiverRuc: text(input, 'receiverRuc', ''),
      paymentCondition: condition ?? null,
      totals: parseTotals(input['totals']),
      items: Object.freeze(rawItems.map(parseItem)),
      fieldConfidences: assertFieldConfidences(input['fieldConfidences']),
      overallConfidence: overall,
    });
  } catch (error) {
    if (error instanceof InvalidConfidenceError) {
      throw new InvalidExtractionResultError(error.message);
    }
    throw error;
  }
}

/** Projection consumed by `validateReceivedDocument` (item amounts = non-null subtotals). */
export function toReceivedDocumentFields(result: ExtractionResult): ReceivedDocumentFields {
  return {
    cdc: result.cdc,
    issuerRuc: result.issuerRuc,
    issuerLegalName: result.issuerLegalName,
    documentNumber: result.documentNumber,
    issueDate: result.issueDate,
    totals: result.totals,
    itemAmounts: result.items.flatMap((item) => (item.subtotal === null ? [] : [item.subtotal])),
  };
}

/**
 * True when the extraction lists items but every subtotal is null: `toReceivedDocumentFields` then
 * hands over no item amounts and the items-sum check is skipped, so the result is not auto-confirmable.
 */
export function hasUnverifiableItems(result: ExtractionResult): boolean {
  return result.items.length > 0 && result.items.every((item) => item.subtotal === null);
}
