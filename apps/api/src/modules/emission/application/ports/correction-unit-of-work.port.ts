import type { AcceptanceUnit } from './acceptance-unit-of-work.port.js';

/** A document as the correction sees it, locked for the rest of the transaction. */
export interface CorrectableDocument {
  id: string;
  cdc: string;
  /** iTiDE. */
  documentType: number;
  status: string;
  /** dEst and dPunExp of the document's number. */
  establishmentCode: string;
  expeditionPointCode: string;
  associatedCdc: string | null;
  payload: unknown;
  /** The SIFEN messages of the rejection, kept in the correction history. */
  sifenMessages: unknown;
}

/** The outcome stored for an earlier correction request that used an `Idempotency-Key`. */
export interface StoredCorrection {
  documentId: string;
  cdc: string;
  requestHash: string;
}

export interface CorrectionRewrite {
  document: CorrectableDocument;
  payload: unknown;
  receiverRuc: string | null;
  totalAmount: string;
  idempotencyKey: string;
  requestHash: string;
}

/** Operations that must share one tenant transaction (ADR-0021). */
export interface CorrectionUnit extends Pick<
  AcceptanceUnit,
  'resolveIssuer' | 'findAssociatedInvoice' | 'sumCreditNotes' | 'recordAudit'
> {
  /** The correction an earlier request with this key made, or null. */
  findCorrectionByKey(key: string): Promise<StoredCorrection | null>;
  /** The tenant's document, locked `FOR UPDATE`, or null (another tenant's is none). */
  lockDocument(documentId: string): Promise<CorrectableDocument | null>;
  /**
   * Keeps the previous body and rejection messages in the history, then rewrites the `rejected` row
   * to `accepted` through the guard door (signed XML cleared, queue state reset, correction counted).
   * @throws IdempotencyKeyCollisionError when the key was taken by a concurrent commit.
   */
  rewriteDocument(change: CorrectionRewrite): Promise<void>;
}

export interface CorrectionUnitOfWork {
  run<T>(tenantId: string, work: (unit: CorrectionUnit) => Promise<T>): Promise<T>;
}
