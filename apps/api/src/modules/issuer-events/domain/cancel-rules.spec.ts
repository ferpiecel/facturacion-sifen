import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CANCEL_WINDOW,
  cancelDeadline,
  validateCancelReason,
  validateCancellation,
  type CancelCandidate,
} from './cancel-rules.js';

const APPROVED = new Date('2026-10-10T12:00:00Z');
const hours = (h: number) => new Date(APPROVED.getTime() + h * 3_600_000);

const candidate = (overrides: Partial<CancelCandidate> = {}): CancelCandidate => ({
  documentType: 1,
  status: 'approved',
  approvedAt: APPROVED,
  signedAt: null,
  liveAssociatedCdcs: [],
  ...overrides,
});

/** Spec: HU-E8-02. MT v150 11.5.1 (GEC003), 11.6.1 (4002, 4009, 4010), plan v1.1 2.2 and 8.3. */
describe('validateCancelReason', () => {
  it('accepts 5 to 500 characters and trims the text', () => {
    expect(validateCancelReason('  error en el importe ')).toEqual({
      ok: true,
      value: 'error en el importe',
    });
    expect(validateCancelReason('a'.repeat(500)).ok).toBe(true);
    expect(validateCancelReason('abcde').ok).toBe(true);
  });

  it('refuses shorter, longer and non-text reasons', () => {
    expect(validateCancelReason('abcd')).toEqual({ ok: false, error: 'reason-length' });
    expect(validateCancelReason('   abc   ')).toEqual({ ok: false, error: 'reason-length' });
    expect(validateCancelReason('a'.repeat(501))).toEqual({ ok: false, error: 'reason-length' });
    expect(validateCancelReason(undefined)).toEqual({ ok: false, error: 'reason-length' });
    expect(validateCancelReason(12345)).toEqual({ ok: false, error: 'reason-length' });
  });
});

describe('cancelDeadline', () => {
  it('is 48 h after approval for an FE minus the safety margin', () => {
    expect(cancelDeadline(1, APPROVED, DEFAULT_CANCEL_WINDOW)).toEqual(
      new Date(hours(48).getTime() - 15 * 60_000),
    );
  });

  it.each([4, 5, 6, 7])('is 168 h after approval for type %i', (type) => {
    expect(cancelDeadline(type, APPROVED, DEFAULT_CANCEL_WINDOW)).toEqual(
      new Date(hours(168).getTime() - 15 * 60_000),
    );
  });

  it('is unknown for a type the manual gives no window to', () => {
    expect(cancelDeadline(8, APPROVED, DEFAULT_CANCEL_WINDOW)).toBeNull();
    expect(cancelDeadline(2, APPROVED, DEFAULT_CANCEL_WINDOW)).toBeNull();
  });

  it('follows a configured window and margin', () => {
    expect(
      cancelDeadline(1, APPROVED, { feHours: 24, otherHours: 100, safetyMarginMinutes: 0 }),
    ).toEqual(hours(24));
  });
});

describe('validateCancellation', () => {
  it('accepts an FE approved 47 hours ago', () => {
    expect(validateCancellation(candidate(), hours(47), DEFAULT_CANCEL_WINDOW)).toBeNull();
  });

  it('accepts an approved-with-observations document', () => {
    expect(
      validateCancellation(
        candidate({ status: 'approved_with_observations' }),
        hours(1),
        DEFAULT_CANCEL_WINDOW,
      ),
    ).toBeNull();
  });

  it('refuses an FE at 49 hours with 4009 and a credit note at 49 hours accepts', () => {
    expect(validateCancellation(candidate(), hours(49), DEFAULT_CANCEL_WINDOW)).toMatchObject({
      rule: 'cancel-window-expired',
      sifenCode: '4009',
    });
    expect(
      validateCancellation(candidate({ documentType: 5 }), hours(49), DEFAULT_CANCEL_WINDOW),
    ).toBeNull();
  });

  it('gives a credit note, debit note, self-invoice and remission note 168 hours (4010)', () => {
    for (const documentType of [4, 5, 6, 7]) {
      const c = candidate({ documentType });
      expect(validateCancellation(c, hours(167), DEFAULT_CANCEL_WINDOW)).toBeNull();
      expect(validateCancellation(c, hours(169), DEFAULT_CANCEL_WINDOW)).toMatchObject({
        rule: 'cancel-window-expired',
        sifenCode: '4010',
      });
    }
  });

  it('refuses inside the safety margin before the limit', () => {
    const at = new Date(hours(48).getTime() - 5 * 60_000);
    expect(validateCancellation(candidate(), at, DEFAULT_CANCEL_WINDOW)).toMatchObject({
      rule: 'cancel-window-expired',
    });
  });

  it.each(['accepted', 'signed', 'queued', 'submitted', 'rejected', 'cancelled', 'number_voided'])(
    'refuses a %s document: SIFEN does not hold it as approved (4002)',
    (status) => {
      expect(
        validateCancellation(candidate({ status }), hours(1), DEFAULT_CANCEL_WINDOW),
      ).toMatchObject({ rule: 'document-not-approved', sifenCode: '4002' });
    },
  );

  it('refuses a document type the manual gives no window to', () => {
    expect(
      validateCancellation(candidate({ documentType: 8 }), hours(1), DEFAULT_CANCEL_WINDOW),
    ).toMatchObject({ rule: 'cancel-document-type-unsupported' });
  });

  it('lists the live associated documents and refuses (cancel from the last to the first)', () => {
    const refusal = validateCancellation(
      candidate({ liveAssociatedCdcs: ['c1', 'c2'] }),
      hours(1),
      DEFAULT_CANCEL_WINDOW,
    );
    expect(refusal).toMatchObject({
      rule: 'has-live-associated-documents',
      associatedCdcs: ['c1', 'c2'],
    });
  });

  it('does not block on the receiver having confirmed the document (NT 025)', () => {
    expect(validateCancellation(candidate(), hours(1), DEFAULT_CANCEL_WINDOW)).toBeNull();
  });

  describe('a row approved before approved_at existed', () => {
    it('falls back to the signing instant, which is never later than the approval', () => {
      const signedAt = new Date(APPROVED.getTime() - 3_600_000);
      const c = candidate({ approvedAt: null, signedAt });
      // The approval is at or after the signature, so the limit counted from it is the earliest possible one.
      expect(
        validateCancellation(
          c,
          new Date(signedAt.getTime() + 47 * 3_600_000),
          DEFAULT_CANCEL_WINDOW,
        ),
      ).toBeNull();
      expect(
        validateCancellation(
          c,
          new Date(signedAt.getTime() + 49 * 3_600_000),
          DEFAULT_CANCEL_WINDOW,
        ),
      ).toMatchObject({ rule: 'cancel-window-expired' });
    });

    it('refuses when there is no instant at all', () => {
      expect(
        validateCancellation(
          candidate({ approvedAt: null, signedAt: null }),
          hours(1),
          DEFAULT_CANCEL_WINDOW,
        ),
      ).toMatchObject({ rule: 'approval-instant-unknown' });
    });
  });
});
