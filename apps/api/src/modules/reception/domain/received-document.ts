import type { ReceptionEventType } from './reception-events.js';
import { assertTransition, type ReceivedDocumentStatus } from './received-document-status.js';
import { isReceivedDocumentSource, type ReceivedDocumentSource } from './source.js';

/** Minimal immutable state needed by the status machine; persistence fields live elsewhere. */
export interface ReceivedDocument {
  readonly id: string;
  readonly tenantId: string;
  readonly source: ReceivedDocumentSource;
  readonly status: ReceivedDocumentStatus;
  /** Optimistic-lock version, starts at 1. */
  readonly version: number;
  /** Always equal to `status === 'needs_review'`. */
  readonly needsReview: boolean;
  readonly needsReviewReasons: readonly string[];
  /** False when the receiver RUC is not the tenant's: stored, but webhook-silent (plan Q3). */
  readonly isOwnReceiver: boolean;
  /** Decimal string in [0, 1] (never a float), or null when not computed. */
  readonly confidenceOverall: string | null;
  readonly extractionAttempts: number;
  readonly confirmedAt: Date | null;
}

export class InvalidReceivedDocumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidReceivedDocumentError';
  }
}

export interface CreateReceivedDocumentInput {
  readonly id: string;
  readonly tenantId: string;
  readonly source: ReceivedDocumentSource;
  readonly isOwnReceiver: boolean;
}

/** @throws InvalidReceivedDocumentError for an empty id, empty tenant or unknown source. */
export function createReceivedDocument(input: CreateReceivedDocumentInput): ReceivedDocument {
  return rehydrateReceivedDocument({
    ...input,
    status: 'received',
    version: 1,
    needsReview: false,
    needsReviewReasons: [],
    confidenceOverall: null,
    extractionAttempts: 0,
    confirmedAt: null,
  });
}

/** @throws InvalidReceivedDocumentError when the state breaks an aggregate invariant. */
export function rehydrateReceivedDocument(state: ReceivedDocument): ReceivedDocument {
  const violation = findInvariantViolation(state);
  if (violation !== null) {
    throw new InvalidReceivedDocumentError(violation);
  }
  return Object.freeze({
    ...state,
    needsReviewReasons: Object.freeze([...state.needsReviewReasons]),
  });
}

const CONFIDENCE = /^(?:0(?:\.\d{1,3})?|1(?:\.0{1,3})?)$/;

/** Returns a description of the first broken invariant, or null when the state is consistent. */
export function findInvariantViolation(state: ReceivedDocument): string | null {
  if (state.id === '') return 'id is required';
  if (state.tenantId === '') return 'tenant id is required';
  if (!isReceivedDocumentSource(state.source)) return `unknown source ${String(state.source)}`;
  if (!Number.isInteger(state.version) || state.version < 1)
    return 'version must be an integer >= 1';
  if (!Number.isInteger(state.extractionAttempts) || state.extractionAttempts < 0) {
    return 'extraction attempts must be an integer >= 0';
  }
  if (state.needsReview !== (state.status === 'needs_review')) {
    return 'needsReview must be true exactly when the status is needs_review';
  }
  if (state.status === 'needs_review' && state.needsReviewReasons.length === 0) {
    return 'needs_review requires at least one reason';
  }
  if (state.status !== 'needs_review' && state.needsReviewReasons.length > 0) {
    return 'reasons are only allowed while needs_review';
  }
  if (state.confidenceOverall !== null && !CONFIDENCE.test(state.confidenceOverall)) {
    return 'confidenceOverall must be a decimal string between 0 and 1 (max 3 decimals)';
  }
  if ((state.status === 'confirmed') !== (state.confirmedAt !== null)) {
    return 'confirmedAt must be set exactly when the status is confirmed';
  }
  return null;
}

export interface TransitionOptions {
  /** Time of the change; becomes `confirmedAt` on the first confirmation. */
  readonly at: Date;
  /** Required (non-empty) when entering `needs_review`; ignored otherwise. */
  readonly reasons?: readonly string[];
  readonly confidenceOverall?: string;
}

export interface TransitionResult {
  readonly document: ReceivedDocument;
  /** Webhook event to enqueue in the same transaction, or null (no event, or silent document). */
  readonly event: ReceptionEventType | null;
}

/**
 * Pure status change. The version moves by exactly one for caller-driven mutations (confirming,
 * editing a confirmed document, reprocessing) and stays put for worker-driven progress.
 *
 * @throws InvalidStatusTransitionError for a pair outside the table.
 * @throws InvalidReceivedDocumentError when the result would break an invariant.
 */
export function transitionReceivedDocument(
  document: ReceivedDocument,
  to: ReceivedDocumentStatus,
  options: TransitionOptions,
): TransitionResult {
  assertTransition(document.status, to);
  const edit = document.status === 'confirmed' && to === 'confirmed';
  const next = rehydrateReceivedDocument({
    ...document,
    status: to,
    version: document.version + (bumpsVersion(document.status, to) ? 1 : 0),
    needsReview: to === 'needs_review',
    needsReviewReasons: to === 'needs_review' ? [...(options.reasons ?? [])] : [],
    confidenceOverall: options.confidenceOverall ?? document.confidenceOverall,
    extractionAttempts: document.extractionAttempts + (to === 'extracting' ? 1 : 0),
    confirmedAt: to === 'confirmed' ? (edit ? document.confirmedAt : options.at) : null,
  });
  return { document: next, event: document.isOwnReceiver ? eventFor(document.status, to) : null };
}

function bumpsVersion(from: ReceivedDocumentStatus, to: ReceivedDocumentStatus): boolean {
  return to === 'confirmed' || (from === 'extraction_failed' && to === 'extracting');
}

function eventFor(
  from: ReceivedDocumentStatus,
  to: ReceivedDocumentStatus,
): ReceptionEventType | null {
  if (to === 'confirmed') {
    return from === 'confirmed' ? 'reception.document.updated' : 'reception.document.confirmed';
  }
  if (to === 'needs_review') return 'reception.document.needs_review';
  if (to === 'extraction_failed') return 'reception.document.extraction_failed';
  return null;
}
