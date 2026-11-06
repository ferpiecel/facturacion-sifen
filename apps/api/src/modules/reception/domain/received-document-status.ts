export const RECEIVED_DOCUMENT_STATUSES = [
  'received',
  'extracting',
  'extracted',
  'needs_review',
  'extraction_failed',
  'confirmed',
] as const;

export type ReceivedDocumentStatus = (typeof RECEIVED_DOCUMENT_STATUSES)[number];

export function isReceivedDocumentStatus(value: unknown): value is ReceivedDocumentStatus {
  return (
    typeof value === 'string' && (RECEIVED_DOCUMENT_STATUSES as readonly string[]).includes(value)
  );
}

/**
 * Allowed transitions. XML ingest goes received -> extracted -> confirmed inside one transaction;
 * `confirmed -> confirmed` is an edit of a confirmed document and `extraction_failed -> extracting`
 * is a reprocess. Anything absent from this table is invalid.
 */
export const STATUS_TRANSITIONS: Readonly<
  Record<ReceivedDocumentStatus, readonly ReceivedDocumentStatus[]>
> = {
  received: ['extracting', 'extracted'],
  extracting: ['extracted', 'extraction_failed'],
  extracted: ['confirmed', 'needs_review'],
  needs_review: ['confirmed'],
  extraction_failed: ['extracting'],
  confirmed: ['confirmed'],
};

export class InvalidStatusTransitionError extends Error {
  constructor(
    readonly from: ReceivedDocumentStatus,
    readonly to: ReceivedDocumentStatus,
  ) {
    super(`invalid received document transition ${from} -> ${to}`);
    this.name = 'InvalidStatusTransitionError';
  }
}

export function canTransition(from: ReceivedDocumentStatus, to: ReceivedDocumentStatus): boolean {
  return STATUS_TRANSITIONS[from].includes(to);
}

/** @throws InvalidStatusTransitionError when the pair is not in {@link STATUS_TRANSITIONS}. */
export function assertTransition(from: ReceivedDocumentStatus, to: ReceivedDocumentStatus): void {
  if (!canTransition(from, to)) {
    throw new InvalidStatusTransitionError(from, to);
  }
}
