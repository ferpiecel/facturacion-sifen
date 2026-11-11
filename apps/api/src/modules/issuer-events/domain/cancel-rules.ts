/**
 * Rules for cancelling an approved DTE (HU-E8-02). Pure: no framework, no clock of its own.
 * Sources: MT v150 11.5.1 (GEC003, reason of 5 to 500 characters) and 11.6.1 (4002, 4009, 4010).
 */

export interface CancelWindowConfig {
  /** MT v150 11.6.1, 4009: an FE (CDC type 01) may be cancelled up to 48 hours after SIFEN approved it. */
  readonly feHours: number;
  /** MT v150 11.6.1, 4010: AFE, NCE, NDE and NRE (CDC type 04 to 07), up to 168 hours. */
  readonly otherHours: number;
  /**
   * Minutes taken off the limit. `approved_at` is the instant the platform saw the approval, which is after
   * the instant SIFEN stamped it, so the real limit is a little earlier than the one computed from it.
   */
  readonly safetyMarginMinutes: number;
}

export const DEFAULT_CANCEL_WINDOW: CancelWindowConfig = {
  feHours: 48,
  otherHours: 168,
  safetyMarginMinutes: 15,
};

export interface CancelCandidate {
  /** `iTiDE`. */
  readonly documentType: number;
  readonly status: string;
  /** When SIFEN approved it; null on a row approved before the column existed. */
  readonly approvedAt: Date | null;
  /** Fallback for those rows: signing happens before sending, so it is never later than the approval. */
  readonly signedAt: Date | null;
  /** CDCs of the documents associated to this one that were not cancelled or voided. */
  readonly liveAssociatedCdcs: readonly string[];
}

export type CancelRefusal =
  | { rule: 'document-not-approved'; sifenCode: '4002'; message: string }
  | { rule: 'cancel-document-type-unsupported'; message: string }
  | { rule: 'has-live-associated-documents'; message: string; associatedCdcs: string[] }
  | { rule: 'approval-instant-unknown'; message: string }
  | { rule: 'cancel-window-expired'; sifenCode: '4009' | '4010'; message: string; deadline: Date };

const APPROVED_STATUSES = ['approved', 'approved_with_observations'];
const FE = 1;
const OTHER_WITH_WINDOW = [4, 5, 6, 7];

export type CancelReasonResult =
  { ok: true; value: string } | { ok: false; error: 'reason-length' };

/** GEC003: `mOtEve` of 5 to 500 characters. */
export function validateCancelReason(reason: unknown): CancelReasonResult {
  if (typeof reason !== 'string') return { ok: false, error: 'reason-length' };
  const value = reason.trim();
  return value.length >= 5 && value.length <= 500
    ? { ok: true, value }
    : { ok: false, error: 'reason-length' };
}

/** The last instant at which the platform lets the cancellation be signed, or null for a type with no window. */
export function cancelDeadline(
  documentType: number,
  approvedAt: Date,
  config: CancelWindowConfig,
): Date | null {
  let windowHours: number;
  if (documentType === FE) windowHours = config.feHours;
  else if (OTHER_WITH_WINDOW.includes(documentType)) windowHours = config.otherHours;
  else return null;
  return new Date(
    approvedAt.getTime() + windowHours * 3_600_000 - config.safetyMarginMinutes * 60_000,
  );
}

/** The first rule the cancellation breaks at `at`, or null when it may go ahead. */
export function validateCancellation(
  candidate: CancelCandidate,
  at: Date,
  config: CancelWindowConfig,
): CancelRefusal | null {
  if (!APPROVED_STATUSES.includes(candidate.status)) {
    return {
      rule: 'document-not-approved',
      sifenCode: '4002',
      message: 'Only a document approved by SIFEN can be cancelled.',
    };
  }
  if (candidate.documentType !== FE && !OTHER_WITH_WINDOW.includes(candidate.documentType)) {
    return {
      rule: 'cancel-document-type-unsupported',
      message: 'This document type has no cancellation window in the technical manual.',
    };
  }
  if (candidate.liveAssociatedCdcs.length > 0) {
    return {
      rule: 'has-live-associated-documents',
      message: 'Cancel the associated documents first, from the last to the first.',
      associatedCdcs: [...candidate.liveAssociatedCdcs],
    };
  }
  const instant = candidate.approvedAt ?? candidate.signedAt;
  if (!instant) {
    return {
      rule: 'approval-instant-unknown',
      message: 'The approval instant of this document is not recorded.',
    };
  }
  const deadline = cancelDeadline(candidate.documentType, instant, config);
  if (deadline && at.getTime() > deadline.getTime()) {
    return {
      rule: 'cancel-window-expired',
      sifenCode: candidate.documentType === FE ? '4009' : '4010',
      message: 'The cancellation window of this document has expired.',
      deadline,
    };
  }
  return null;
}
