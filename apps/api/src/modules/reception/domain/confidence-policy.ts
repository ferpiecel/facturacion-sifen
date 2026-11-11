import type { ValidationReason } from './received-document-validation.js';

/** The 8 curated fields that carry a confidence (ADR-0026; matches the DB check constraint). */
export const RECEIVED_FIELD_NAMES = [
  'issuer_ruc',
  'issuer_legal_name',
  'issued_on',
  'document_number',
  'receiver_ruc',
  'payment_condition',
  'totals',
  'items',
] as const;

export type ReceivedFieldName = (typeof RECEIVED_FIELD_NAMES)[number];

export type FieldConfidences = Readonly<Record<ReceivedFieldName, number>>;

/** Reasons a document leaves extraction as `needs_review`. */
export type ReviewReason = ValidationReason | 'low_confidence';

export class InvalidConfidenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidConfidenceError';
  }
}

/** @throws InvalidConfidenceError unless `value` is a finite number in [0, 1]. */
export function assertConfidence(value: unknown, label: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new InvalidConfidenceError(`${label} must be a number between 0 and 1`);
  }
}

/** @throws InvalidConfidenceError unless exactly the 8 curated fields are present, each in [0, 1]. */
export function assertFieldConfidences(value: unknown): FieldConfidences {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new InvalidConfidenceError('field confidences must be an object');
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!(RECEIVED_FIELD_NAMES as readonly string[]).includes(key)) {
      throw new InvalidConfidenceError(`unknown confidence field ${key}`);
    }
  }
  for (const name of RECEIVED_FIELD_NAMES) {
    assertConfidence(record[name], `confidence of ${name}`);
  }
  return Object.freeze({ ...record }) as FieldConfidences;
}

/**
 * Auto-confirm threshold as a validated value object. The number is read from configuration in
 * exactly one place (the module wiring); the domain never reads the environment (ADR-0026).
 */
export class ConfidencePolicy {
  private constructor(readonly threshold: number) {
    Object.freeze(this);
  }

  /** @throws InvalidConfidenceError unless the threshold is a finite number in [0, 1]. */
  static create(threshold: number): ConfidencePolicy {
    assertConfidence(threshold, 'confidence threshold');
    return new ConfidencePolicy(threshold);
  }
}

export interface ExtractionDecisionInput {
  readonly overallConfidence: number;
  /** Output of `validateReceivedDocument` for the extracted fields. */
  readonly validationReasons: readonly ValidationReason[];
  readonly issuerRuc: string | null;
  readonly issuerLegalName: string | null;
}

export type ExtractionOutcome =
  | { readonly status: 'confirmed' }
  | { readonly status: 'needs_review'; readonly reasons: readonly ReviewReason[] };

function blank(value: string | null): boolean {
  return value === null || value.trim() === '';
}

/**
 * Post-extraction status. Mirrors project A: a document is reviewed when its global confidence is
 * strictly below the threshold (equal confirms), any validation failed, or an issuer field is
 * missing. Reasons are unique and ordered: validations, issuer gaps, then low confidence.
 *
 * @throws InvalidConfidenceError when `overallConfidence` is outside [0, 1].
 */
export function decideExtractionOutcome(
  policy: ConfidencePolicy,
  input: ExtractionDecisionInput,
): ExtractionOutcome {
  assertConfidence(input.overallConfidence, 'overall confidence');
  const reasons: ReviewReason[] = [...input.validationReasons];
  if (blank(input.issuerRuc)) reasons.push('missing_issuer_ruc');
  if (blank(input.issuerLegalName)) reasons.push('missing_issuer_legal_name');
  if (input.overallConfidence < policy.threshold) reasons.push('low_confidence');
  const unique = [...new Set(reasons)];
  return unique.length === 0
    ? { status: 'confirmed' }
    : { status: 'needs_review', reasons: unique };
}
