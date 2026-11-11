import { z } from 'zod';
import { RECEIVED_FIELD_NAMES } from './confidence-policy.js';
import {
  InvalidExtractionResultError,
  parseExtractionResult,
  type ExtractionResult,
} from './extraction-result.js';

const nullableText = z.string().nullable();
/** Amounts are JSON strings; numbers are rejected, never coerced (no float on the money path). */
const nullableAmount = z.string().nullable();
const confidence = z.number().min(0).max(1);

const itemSchema = z.strictObject({
  description: nullableText,
  productCode: nullableText,
  quantity: nullableAmount,
  unitOfMeasure: nullableText,
  unitPrice: nullableAmount,
  discount: nullableAmount,
  subtotal: nullableAmount,
  vatRate: z.union([z.literal(0), z.literal(5), z.literal(10)]).nullable(),
  taxableBase: nullableAmount,
  vatAmount: nullableAmount,
});

const totalsSchema = z.strictObject({
  exempt: z.string(),
  exonerated: z.string(),
  taxable5: z.string(),
  taxable10: z.string(),
  vat5: z.string(),
  vat10: z.string(),
  total: z.string(),
});

const fieldConfidencesSchema = z.strictObject(
  Object.fromEntries(RECEIVED_FIELD_NAMES.map((name) => [name, confidence])) as Record<
    (typeof RECEIVED_FIELD_NAMES)[number],
    typeof confidence
  >,
);

/** Shape the model is asked to return (camelCase, same keys as `parseExtractionResult`). */
export const extractionOutputSchema = z.strictObject({
  cdc: nullableText,
  issuerRuc: nullableText,
  issuerLegalName: nullableText,
  documentNumber: nullableText,
  issueDate: nullableText,
  receiverRuc: nullableText,
  paymentCondition: z.enum(['cash', 'credit']).nullable(),
  totals: totalsSchema.nullable(),
  items: z.array(itemSchema),
  fieldConfidences: fieldConfidencesSchema,
  overallConfidence: confidence,
  notes: z.string().optional(),
});

/** JSON Schema of {@link extractionOutputSchema}, for providers with structured outputs. */
export const EXTRACTION_OUTPUT_JSON_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze(
  z.toJSONSchema(extractionOutputSchema),
);

export type LlmExtractionErrorCode = 'not_json' | 'schema_violation';

export interface LlmExtractionError {
  readonly code: LlmExtractionErrorCode;
  /** Names paths only; never echoes document content. */
  readonly message: string;
}

export interface LlmExtraction {
  readonly result: ExtractionResult;
  readonly notes: string;
}

export type LlmExtractionOutcome =
  | { readonly ok: true; readonly value: LlmExtraction }
  | { readonly ok: false; readonly error: LlmExtractionError };

const FENCE = /```(?:json)?\s*([\s\S]*?)```/i;

function tryParseObject(candidate: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(candidate);
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Plain JSON, then a fenced block, then the outermost braces (leading or trailing prose). */
function extractJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  const direct = tryParseObject(trimmed);
  if (direct !== null) return direct;
  const fenced = FENCE.exec(trimmed)?.[1];
  if (fenced !== undefined) {
    const fromFence = tryParseObject(fenced.trim());
    if (fromFence !== null) return fromFence;
  }
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  return start >= 0 && end > start ? tryParseObject(trimmed.slice(start, end + 1)) : null;
}

const fail = (code: LlmExtractionErrorCode, message: string): LlmExtractionOutcome => ({
  ok: false,
  error: { code, message },
});

/**
 * Turns the raw text returned by the model into a validated {@link ExtractionResult}. The model is
 * untrusted: the shape is checked with zod and the values again by `parseExtractionResult`.
 */
export function parseLlmExtractionOutput(text: string): LlmExtractionOutcome {
  const json = extractJsonObject(text);
  if (json === null) return fail('not_json', 'model output is not a JSON object');
  const parsed = extractionOutputSchema.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    return fail('schema_violation', issues);
  }
  const { notes, ...data } = parsed.data;
  try {
    return { ok: true, value: { result: parseExtractionResult(data), notes: notes ?? '' } };
  } catch (error) {
    if (error instanceof InvalidExtractionResultError) {
      return fail('schema_violation', error.message);
    }
    throw error;
  }
}
