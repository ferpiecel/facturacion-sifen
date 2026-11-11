import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { RECEPTION_EVENT_TYPES } from './reception-events.js';
import {
  InvalidReceivedDocumentError,
  createReceivedDocument,
  findInvariantViolation,
  rehydrateReceivedDocument,
  transitionReceivedDocument,
  type ReceivedDocument,
} from './received-document.js';
import {
  InvalidStatusTransitionError,
  RECEIVED_DOCUMENT_STATUSES,
  type ReceivedDocumentStatus,
} from './received-document-status.js';

const AT = new Date('2026-11-06T12:00:00.000Z');
const LATER = new Date('2026-11-07T12:00:00.000Z');

function doc(
  status: ReceivedDocumentStatus,
  overrides: Partial<ReceivedDocument> = {},
): ReceivedDocument {
  const needsReview = status === 'needs_review';
  return rehydrateReceivedDocument({
    id: 'doc-1',
    tenantId: 'tenant-1',
    source: 'pdf',
    status,
    version: 1,
    needsReview,
    needsReviewReasons: needsReview ? ['low_confidence'] : [],
    isOwnReceiver: true,
    confidenceOverall: null,
    extractionAttempts: 0,
    confirmedAt: status === 'confirmed' ? AT : null,
    ...overrides,
  });
}

describe('reception event types', () => {
  it('lists exactly the four reception events', () => {
    expect(RECEPTION_EVENT_TYPES).toEqual([
      'reception.document.confirmed',
      'reception.document.needs_review',
      'reception.document.extraction_failed',
      'reception.document.updated',
    ]);
  });
});

describe('createReceivedDocument', () => {
  it('starts in received at version 1 with no review flag', () => {
    const created = createReceivedDocument({
      id: 'doc-1',
      tenantId: 'tenant-1',
      source: 'sifen_xml',
      isOwnReceiver: true,
    });
    expect(created).toMatchObject({
      status: 'received',
      version: 1,
      needsReview: false,
      needsReviewReasons: [],
      confidenceOverall: null,
      extractionAttempts: 0,
      confirmedAt: null,
    });
  });

  it('rejects an unknown source and empty ids', () => {
    expect(() =>
      createReceivedDocument({
        id: 'd',
        tenantId: 't',
        source: 'manual' as never,
        isOwnReceiver: true,
      }),
    ).toThrow(InvalidReceivedDocumentError);
    expect(() =>
      createReceivedDocument({ id: '', tenantId: 't', source: 'pdf', isOwnReceiver: true }),
    ).toThrow(InvalidReceivedDocumentError);
    expect(() =>
      createReceivedDocument({ id: 'd', tenantId: '', source: 'pdf', isOwnReceiver: true }),
    ).toThrow(InvalidReceivedDocumentError);
  });
});

describe('rehydrateReceivedDocument invariants', () => {
  it('rejects a needs_review flag that disagrees with the status (parity both ways)', () => {
    expect(() => doc('extracted', { needsReview: true })).toThrow(InvalidReceivedDocumentError);
    expect(() => doc('needs_review', { needsReview: false })).toThrow(InvalidReceivedDocumentError);
  });

  it('rejects reasons outside needs_review, a needs_review without reasons and bad confidence', () => {
    expect(() => doc('extracted', { needsReviewReasons: ['x'] })).toThrow(
      InvalidReceivedDocumentError,
    );
    expect(() => doc('needs_review', { needsReviewReasons: [] })).toThrow(
      InvalidReceivedDocumentError,
    );
    expect(() => doc('extracted', { confidenceOverall: '1.5' })).toThrow(
      InvalidReceivedDocumentError,
    );
    expect(() => doc('extracted', { confidenceOverall: 'abc' })).toThrow(
      InvalidReceivedDocumentError,
    );
    expect(() => doc('extracted', { confidenceOverall: '0.850' })).not.toThrow();
  });

  it('rejects a bad version, negative attempts and a confirmed document without confirmedAt', () => {
    expect(() => doc('received', { version: 0 })).toThrow(InvalidReceivedDocumentError);
    expect(() => doc('received', { extractionAttempts: -1 })).toThrow(InvalidReceivedDocumentError);
    expect(() => doc('confirmed', { confirmedAt: null })).toThrow(InvalidReceivedDocumentError);
    expect(() => doc('extracted', { confirmedAt: AT })).toThrow(InvalidReceivedDocumentError);
  });
});

describe('transitionReceivedDocument', () => {
  it('returns a new instance and never mutates the input', () => {
    const before = doc('received');
    const { document } = transitionReceivedDocument(before, 'extracting', { at: AT });
    expect(document).not.toBe(before);
    expect(before.status).toBe('received');
    expect(before.version).toBe(1);
  });

  it('throws a typed error for an invalid transition', () => {
    expect(() => transitionReceivedDocument(doc('received'), 'confirmed', { at: AT })).toThrow(
      InvalidStatusTransitionError,
    );
  });

  it('counts an extraction attempt on every entry into extracting', () => {
    const first = transitionReceivedDocument(doc('received'), 'extracting', { at: AT }).document;
    expect(first.extractionAttempts).toBe(1);
    const failed = transitionReceivedDocument(first, 'extraction_failed', { at: AT }).document;
    const again = transitionReceivedDocument(failed, 'extracting', { at: AT }).document;
    expect(again.extractionAttempts).toBe(2);
  });

  describe('version', () => {
    it('does not bump on worker-driven transitions', () => {
      const extracting = transitionReceivedDocument(doc('received'), 'extracting', {
        at: AT,
      }).document;
      expect(extracting.version).toBe(1);
      const extracted = transitionReceivedDocument(extracting, 'extracted', { at: AT }).document;
      expect(extracted.version).toBe(1);
      const review = transitionReceivedDocument(extracted, 'needs_review', {
        at: AT,
        reasons: ['low_confidence'],
      }).document;
      expect(review.version).toBe(1);
      const failed = transitionReceivedDocument(doc('extracting'), 'extraction_failed', { at: AT });
      expect(failed.document.version).toBe(1);
    });

    it('bumps by exactly one on confirm, edit of a confirmed document and reprocess', () => {
      expect(
        transitionReceivedDocument(doc('extracted'), 'confirmed', { at: AT }).document.version,
      ).toBe(2);
      expect(
        transitionReceivedDocument(doc('needs_review'), 'confirmed', { at: AT }).document.version,
      ).toBe(2);
      expect(
        transitionReceivedDocument(doc('confirmed'), 'confirmed', { at: LATER }).document.version,
      ).toBe(2);
      expect(
        transitionReceivedDocument(doc('extraction_failed'), 'extracting', { at: AT }).document
          .version,
      ).toBe(2);
    });

    it('XML ingest (received -> extracted -> confirmed) ends at version 2', () => {
      const extracted = transitionReceivedDocument(
        doc('received', { source: 'sifen_xml' }),
        'extracted',
        {
          at: AT,
        },
      ).document;
      const confirmed = transitionReceivedDocument(extracted, 'confirmed', { at: AT }).document;
      expect(confirmed.version).toBe(2);
    });
  });

  describe('needs_review parity', () => {
    it('sets the flag and reasons on entering needs_review', () => {
      const { document } = transitionReceivedDocument(doc('extracted'), 'needs_review', {
        at: AT,
        reasons: ['low_confidence', 'totals_mismatch'],
      });
      expect(document.needsReview).toBe(true);
      expect(document.needsReviewReasons).toEqual(['low_confidence', 'totals_mismatch']);
    });

    it('requires at least one reason to enter needs_review', () => {
      expect(() =>
        transitionReceivedDocument(doc('extracted'), 'needs_review', { at: AT }),
      ).toThrow(InvalidReceivedDocumentError);
      expect(() =>
        transitionReceivedDocument(doc('extracted'), 'needs_review', { at: AT, reasons: [] }),
      ).toThrow(InvalidReceivedDocumentError);
    });

    it('clears flag and reasons on needs_review -> confirmed and stamps confirmedAt', () => {
      const { document } = transitionReceivedDocument(doc('needs_review'), 'confirmed', {
        at: LATER,
      });
      expect(document.needsReview).toBe(false);
      expect(document.needsReviewReasons).toEqual([]);
      expect(document.confirmedAt).toEqual(LATER);
    });

    it('keeps the original confirmedAt when a confirmed document is edited', () => {
      const { document } = transitionReceivedDocument(doc('confirmed'), 'confirmed', { at: LATER });
      expect(document.confirmedAt).toEqual(AT);
    });

    it('stores confidenceOverall when provided and rejects an out-of-range value', () => {
      const { document } = transitionReceivedDocument(doc('extracting'), 'extracted', {
        at: AT,
        confidenceOverall: '0.912',
      });
      expect(document.confidenceOverall).toBe('0.912');
      expect(() =>
        transitionReceivedDocument(doc('extracting'), 'extracted', {
          at: AT,
          confidenceOverall: '1.001',
        }),
      ).toThrow(InvalidReceivedDocumentError);
    });
  });

  describe('events', () => {
    it.each([
      ['extracted', 'confirmed', 'reception.document.confirmed'],
      ['needs_review', 'confirmed', 'reception.document.confirmed'],
      ['extracted', 'needs_review', 'reception.document.needs_review'],
      ['extracting', 'extraction_failed', 'reception.document.extraction_failed'],
      ['confirmed', 'confirmed', 'reception.document.updated'],
    ] as const)('%s -> %s emits %s', (from, to, expected) => {
      const { event } = transitionReceivedDocument(doc(from), to, {
        at: AT,
        reasons: ['low_confidence'],
      });
      expect(event).toBe(expected);
    });

    it.each([
      ['received', 'extracting'],
      ['received', 'extracted'],
      ['extracting', 'extracted'],
      ['extraction_failed', 'extracting'],
    ] as const)('%s -> %s emits no event', (from, to) => {
      expect(transitionReceivedDocument(doc(from), to, { at: AT }).event).toBeNull();
    });

    it.each([
      ['extracted', 'confirmed'],
      ['needs_review', 'confirmed'],
      ['extracted', 'needs_review'],
      ['extracting', 'extraction_failed'],
      ['confirmed', 'confirmed'],
    ] as const)('%s -> %s is silent for a document not addressed to the tenant', (from, to) => {
      const { event } = transitionReceivedDocument(doc(from, { isOwnReceiver: false }), to, {
        at: AT,
        reasons: ['low_confidence'],
      });
      expect(event).toBeNull();
    });
  });
});

describe('property: random transition sequences', () => {
  const attempt = fc.record({
    to: fc.constantFrom(...RECEIVED_DOCUMENT_STATUSES),
    reasons: fc.option(
      fc.array(fc.constantFrom('low_confidence', 'totals_mismatch'), { maxLength: 2 }),
    ),
    confidence: fc.option(fc.constantFrom('0', '0.5', '1', '0.999')),
  });

  it('never violates the invariants and never decreases the version', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...(['sifen_xml', 'ekuatia_cdc', 'pdf', 'photo'] as const)),
        fc.boolean(),
        fc.array(attempt, { maxLength: 40 }),
        (source, isOwnReceiver, attempts) => {
          let current = createReceivedDocument({ id: 'd', tenantId: 't', source, isOwnReceiver });
          for (const { to, reasons, confidence } of attempts) {
            const before = current;
            try {
              const result = transitionReceivedDocument(before, to, {
                at: AT,
                ...(reasons !== null ? { reasons } : {}),
                ...(confidence !== null ? { confidenceOverall: confidence } : {}),
              });
              current = result.document;
              expect(current.version - before.version).toBeLessThanOrEqual(1);
              if (!isOwnReceiver) expect(result.event).toBeNull();
            } catch (error) {
              expect(
                error instanceof InvalidStatusTransitionError ||
                  error instanceof InvalidReceivedDocumentError,
              ).toBe(true);
              expect(current).toBe(before);
            }
            expect(findInvariantViolation(current)).toBeNull();
            expect(current.version).toBeGreaterThanOrEqual(before.version);
            expect(current.needsReview).toBe(current.status === 'needs_review');
          }
        },
      ),
    );
  });
});
