/**
 * Rules for correcting an event of the receiver (HU-E9-02). Pure. Source: MT v150 Tabla K (a conformity,
 * disconformity or unawareness is corrected once, within 15 days, with a free-text justification) and
 * NT 019 point 5 (the last event registered stands).
 */
import {
  DEFAULT_RECEIVER_EVENT_CONFIG,
  OPPOSITE,
  validateReceiverEvent,
  type PriorReceiverEvent,
  type ReceiverEventConfig,
  type ReceiverEventKind,
  type ReceiverEventRefusal,
  type ConformityType,
  type ReceiverEventRequest,
} from './receiver-event-rules.js';

/** The stored event a correction is about, with what the rules need to know of it. */
export interface CorrectableEvent {
  readonly kind: ReceiverEventKind;
  readonly conformityType?: ConformityType | undefined;
  readonly status: string;
  /** When SIFEN registered it; the 15 days count from here. */
  readonly respondedAt: Date | null;
  readonly isCorrection: boolean;
  readonly alreadyCorrected: boolean;
  /** No later conclusive event (conformity, disconformity, unawareness) of the CDC supersedes it. */
  readonly isLatestConclusive: boolean;
}

export type CorrectionRefusal =
  | ReceiverEventRefusal
  | {
      rule:
        | 'correction-original-not-approved'
        | 'correction-kind-unsupported'
        | 'correction-of-correction'
        | 'correction-already-requested'
        | 'correction-original-superseded'
        | 'correction-kind-not-opposite';
      message: string;
    }
  | { rule: 'correction-window-expired'; message: string; deadline: Date };

export type CorrectionReasonResult = { ok: true; value: string } | { ok: false };

/** MT Tabla K: the justification is free text; 5 to 500 characters like `mOtEve`. */
export function validateCorrectionReason(reason: unknown): CorrectionReasonResult {
  if (typeof reason !== 'string') return { ok: false };
  const value = reason.trim();
  return value.length >= 5 && value.length <= 500 ? { ok: true, value } : { ok: false };
}

type SimpleRule = Exclude<CorrectionRefusal, { deadline: Date } | ReceiverEventRefusal>['rule'];

const refuse = (rule: SimpleRule, message: string): CorrectionRefusal => ({ rule, message });

/**
 * The first rule the correction breaks at `at`, or null. `replacement` is the event that takes the place of
 * `original`; `history` holds the CDC's events SIFEN has not refused, `original` included.
 */
export function validateCorrection(
  original: CorrectableEvent,
  replacement: ReceiverEventRequest,
  history: readonly PriorReceiverEvent[],
  at: Date,
  config: ReceiverEventConfig = DEFAULT_RECEIVER_EVENT_CONFIG,
): CorrectionRefusal | null {
  if (original.status !== 'approved') {
    return refuse(
      'correction-original-not-approved',
      'Only an event SIFEN approved can be corrected.',
    );
  }
  if (original.kind === 'receipt_notice') {
    return refuse('correction-kind-unsupported', 'A receipt notice cannot be corrected.');
  }
  if (original.isCorrection) {
    return refuse('correction-of-correction', 'A correction cannot be corrected.');
  }
  if (original.alreadyCorrected) {
    return refuse('correction-already-requested', 'This event was already corrected.');
  }
  if (!original.isLatestConclusive) {
    return refuse(
      'correction-original-superseded',
      'A later event of the CDC stands in its place.',
    );
  }
  if (original.kind === replacement.kind) {
    return refuse(
      'correction-kind-not-opposite',
      'A correction registers a different kind of event.',
    );
  }
  if (!OPPOSITE[original.kind]?.includes(replacement.kind)) {
    return refuse('correction-kind-not-opposite', 'This event cannot replace the original.');
  }
  if (original.respondedAt) {
    const deadline = new Date(
      original.respondedAt.getTime() +
        config.correctionDays * 86_400_000 -
        config.safetyMarginMinutes * 60_000,
    );
    if (at.getTime() > deadline.getTime()) {
      return {
        rule: 'correction-window-expired',
        message: 'The deadline to correct this event has expired.',
        deadline,
      };
    }
  }
  return validateReceiverEvent(replacement, history, at, config, { correction: true });
}
