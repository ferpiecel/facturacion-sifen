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
  notes: z.string().nullable(),
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

type JsonProbe =
  | { readonly kind: 'object'; readonly value: Record<string, unknown> }
  | { readonly kind: 'other' }
  | { readonly kind: 'invalid' };

function probe(candidate: string): JsonProbe {
  try {
    const value: unknown = JSON.parse(candidate);
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? { kind: 'object', value: value as Record<string, unknown> }
      : { kind: 'other' };
  } catch {
    return { kind: 'invalid' };
  }
}

/** End index (inclusive) of the balanced `{...}` starting at `start`, honoring JSON strings. */
function balancedEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') i += 1;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Last non-whitespace character before `index`, or '' at the start. */
function previousSignificant(text: string, index: number): string {
  for (let i = index - 1; i >= 0; i -= 1) {
    const ch = text[i] ?? '';
    if (ch.trim() !== '') return ch;
  }
  return '';
}

/**
 * Scans the text for the first balanced `{...}` that parses as an object. A candidate directly
 * after `[` is an element of an array, not the answer, and is skipped.
 */
function scanForObject(text: string): Record<string, unknown> | null {
  let from = text.indexOf('{');
  while (from >= 0) {
    const end = balancedEnd(text, from);
    if (end > from) {
      if (previousSignificant(text, from) !== '[') {
        const found = probe(text.slice(from, end + 1));
        if (found.kind === 'object') return found.value;
      }
      // Never descend into a rejected candidate: its nested objects are not the answer.
      from = text.indexOf('{', end + 1);
    } else {
      from = text.indexOf('{', from + 1);
    }
  }
  return null;
}

/**
 * Plain JSON, then a fenced block, then the first balanced object in surrounding prose. Valid JSON
 * that is not an object (for example an array wrapping the answer) is never unwrapped.
 */
function extractJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  const direct = probe(trimmed);
  if (direct.kind === 'object') return direct.value;
  if (direct.kind === 'other') return null;
  const fenced = FENCE.exec(trimmed)?.[1];
  if (fenced !== undefined) {
    const fromFence = probe(fenced.trim());
    if (fromFence.kind === 'object') return fromFence.value;
    if (fromFence.kind === 'other') return null;
  }
  return scanForObject(trimmed);
}

/** Domain messages read `<path> must be <expectation>`; anything else is not trusted to be value-free. */
const DOMAIN_MESSAGE = /^([A-Za-z0-9_.[\]]+) must be [A-Za-z0-9_ ,'.]+$/;

function valueFreeDomainMessage(message: string): string {
  const path = DOMAIN_MESSAGE.exec(message)?.[1];
  return path === undefined
    ? 'extracted values failed domain validation'
    : `${path}: failed domain validation`;
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
    // Paths and zod issue codes only: raw zod messages can echo model-supplied keys or values.
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.code}`)
      .join('; ');
    return fail('schema_violation', issues);
  }
  const { notes, ...data } = parsed.data;
  try {
    return { ok: true, value: { result: parseExtractionResult(data), notes: notes ?? '' } };
  } catch (error) {
    if (error instanceof InvalidExtractionResultError) {
      return fail('schema_violation', valueFreeDomainMessage(error.message));
    }
    throw error;
  }
}
