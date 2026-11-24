import { describe, expect, it } from 'vitest';
import {
  ConfidencePolicy,
  InvalidConfidenceError,
  RECEIVED_FIELD_NAMES,
  assertConfidence,
  assertFieldConfidences,
  decideExtractionOutcome,
  type ExtractionDecisionInput,
} from './confidence-policy.js';

const policy = ConfidencePolicy.create(0.85);

const good: ExtractionDecisionInput = {
  overallConfidence: 0.95,
  validationReasons: [],
  issuerRuc: '80012345-6',
  issuerLegalName: 'Proveedor SA',
};

describe('decideExtractionOutcome: unverified source', () => {
  it('never confirms a document read by a model, whatever its confidence', () => {
    expect(
      decideExtractionOutcome(policy, { ...good, overallConfidence: 1, unverifiedSource: true }),
    ).toEqual({ status: 'needs_review', reasons: ['unverified_source'] });
  });

  it('keeps the confidence policy for a verified source', () => {
    expect(decideExtractionOutcome(policy, { ...good, unverifiedSource: false })).toEqual({
      status: 'confirmed',
    });
    expect(decideExtractionOutcome(policy, good)).toEqual({ status: 'confirmed' });
  });

  it('lists the reason once, before low_confidence', () => {
    expect(
      decideExtractionOutcome(policy, { ...good, overallConfidence: 0.1, unverifiedSource: true }),
    ).toEqual({ status: 'needs_review', reasons: ['unverified_source', 'low_confidence'] });
  });
});

describe('ConfidencePolicy', () => {
  it.each([0, 0.5, 0.85, 1])('accepts threshold %s', (value) => {
    expect(ConfidencePolicy.create(value).threshold).toBe(value);
  });

  it.each([-0.01, 1.01, Number.NaN, Number.POSITIVE_INFINITY])('rejects threshold %s', (value) => {
    expect(() => ConfidencePolicy.create(value)).toThrow(InvalidConfidenceError);
  });

  it('is immutable', () => {
    expect(Object.isFrozen(policy)).toBe(true);
  });
});

describe('decideExtractionOutcome', () => {
  it('confirms when everything holds', () => {
    expect(decideExtractionOutcome(policy, good)).toEqual({ status: 'confirmed' });
  });

  it('needs review when the global confidence is below the threshold', () => {
    expect(decideExtractionOutcome(policy, { ...good, overallConfidence: 0.84 })).toEqual({
      status: 'needs_review',
      reasons: ['low_confidence'],
    });
  });

  it('confirms exactly at the threshold (A parity: only strictly lower needs review)', () => {
    expect(decideExtractionOutcome(policy, { ...good, overallConfidence: 0.85 })).toEqual({
      status: 'confirmed',
    });
  });

  it('needs review on failed validations even with maximal confidence', () => {
    const outcome = decideExtractionOutcome(policy, {
      ...good,
      overallConfidence: 1,
      validationReasons: ['vat10_inconsistent', 'items_sum_mismatch'],
    });
    expect(outcome).toEqual({
      status: 'needs_review',
      reasons: ['vat10_inconsistent', 'items_sum_mismatch'],
    });
  });

  it.each([
    [{ issuerRuc: null }, 'missing_issuer_ruc'],
    [{ issuerRuc: '  ' }, 'missing_issuer_ruc'],
    [{ issuerLegalName: null }, 'missing_issuer_legal_name'],
    [{ issuerLegalName: '' }, 'missing_issuer_legal_name'],
  ] as const)('needs review when issuer data is missing %j', (override, reason) => {
    expect(decideExtractionOutcome(policy, { ...good, ...override })).toEqual({
      status: 'needs_review',
      reasons: [reason],
    });
  });

  it('lists every reason once, validations first', () => {
    const outcome = decideExtractionOutcome(policy, {
      overallConfidence: 0.1,
      validationReasons: ['missing_issuer_ruc', 'invalid_amount'],
      issuerRuc: null,
      issuerLegalName: null,
    });
    expect(outcome).toEqual({
      status: 'needs_review',
      reasons: [
        'missing_issuer_ruc',
        'invalid_amount',
        'missing_issuer_legal_name',
        'low_confidence',
      ],
    });
  });

  it('needs review when the items cannot be checked against the total', () => {
    expect(decideExtractionOutcome(policy, { ...good, unverifiableItems: true })).toEqual({
      status: 'needs_review',
      reasons: ['items_without_subtotals'],
    });
    expect(decideExtractionOutcome(policy, { ...good, unverifiableItems: false }).status).toBe(
      'confirmed',
    );
  });

  it('places the unverifiable-items reason before low confidence', () => {
    expect(
      decideExtractionOutcome(policy, {
        ...good,
        overallConfidence: 0.1,
        unverifiableItems: true,
      }),
    ).toEqual({ status: 'needs_review', reasons: ['items_without_subtotals', 'low_confidence'] });
  });

  it('honours a custom threshold', () => {
    const strict = ConfidencePolicy.create(0.99);
    expect(decideExtractionOutcome(strict, good).status).toBe('needs_review');
  });

  it('rejects an out-of-range global confidence', () => {
    expect(() => decideExtractionOutcome(policy, { ...good, overallConfidence: 1.2 })).toThrow(
      InvalidConfidenceError,
    );
  });
});

describe('confidence value checks', () => {
  it('lists the 8 curated fields', () => {
    expect(RECEIVED_FIELD_NAMES).toEqual([
      'issuer_ruc',
      'issuer_legal_name',
      'issued_on',
      'document_number',
      'receiver_ruc',
      'payment_condition',
      'totals',
      'items',
    ]);
  });

  it.each([-0.1, 1.1, Number.NaN, '0.5', null])('assertConfidence rejects %s', (value) => {
    expect(() => {
      assertConfidence(value, 'x');
    }).toThrow(InvalidConfidenceError);
  });

  const all = Object.fromEntries(RECEIVED_FIELD_NAMES.map((n) => [n, 0.9]));

  it('accepts a complete field confidence map', () => {
    expect(assertFieldConfidences(all)).toEqual(all);
  });

  it('rejects an out-of-range field confidence naming the field', () => {
    expect(() => assertFieldConfidences({ ...all, totals: 1.5 })).toThrow(/totals/);
  });

  it('rejects a missing field and an unknown field', () => {
    const missing = Object.fromEntries(Object.entries(all).filter(([name]) => name !== 'items'));
    expect(() => assertFieldConfidences(missing)).toThrow(/items/);
    expect(() => assertFieldConfidences({ ...all, extra: 0.5 })).toThrow(/extra/);
    expect(() => assertFieldConfidences(null)).toThrow(InvalidConfidenceError);
  });
});
