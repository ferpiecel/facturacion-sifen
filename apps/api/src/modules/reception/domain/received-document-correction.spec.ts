import { describe, expect, it } from 'vitest';
import {
  InvalidReceivedDocumentError,
  rehydrateReceivedDocument,
  recordReceivedDocumentCorrection,
  type ReceivedDocument,
} from './received-document.js';
import { InvalidStatusTransitionError } from './received-document-status.js';

const AT = new Date('2026-11-06T12:00:00.000Z');

function doc(status: ReceivedDocument['status'], version = 2): ReceivedDocument {
  const needsReview = status === 'needs_review';
  return rehydrateReceivedDocument({
    id: 'doc-1',
    tenantId: 'tenant-1',
    source: 'sifen_xml',
    status,
    version,
    needsReview,
    needsReviewReasons: needsReview ? ['totals_blocks_sum_mismatch'] : [],
    isOwnReceiver: true,
    confidenceOverall: '1.0',
    extractionAttempts: 1,
    confirmedAt: status === 'confirmed' ? AT : null,
  });
}

/** Spec: reception R4.4. A correction that does not confirm still moves the optimistic lock. */
describe('recordReceivedDocumentCorrection', () => {
  it('bumps the version by one and replaces the reasons while staying in needs_review', () => {
    const next = recordReceivedDocumentCorrection(doc('needs_review', 3), ['vat10_inconsistent']);
    expect(next).toMatchObject({
      status: 'needs_review',
      version: 4,
      needsReview: true,
      needsReviewReasons: ['vat10_inconsistent'],
    });
  });

  it('requires at least one reason', () => {
    expect(() => recordReceivedDocumentCorrection(doc('needs_review'), [])).toThrow(
      InvalidReceivedDocumentError,
    );
  });

  it.each(['received', 'extracting', 'extracted', 'extraction_failed', 'confirmed'] as const)(
    'refuses a document in %s',
    (status) => {
      expect(() => recordReceivedDocumentCorrection(doc(status), ['x'])).toThrow(
        InvalidStatusTransitionError,
      );
    },
  );

  it('does not mutate its input', () => {
    const before = doc('needs_review');
    recordReceivedDocumentCorrection(before, ['x']);
    expect(before.version).toBe(2);
    expect(before.needsReviewReasons).toEqual(['totals_blocks_sum_mismatch']);
  });
});
