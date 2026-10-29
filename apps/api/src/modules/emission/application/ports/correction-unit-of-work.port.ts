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
  /** The number, to void it when the document is reissued. */
  timbradoNumber: string;
  /** `''` without a series. */
  series: string;
  number: number;
  /** Start of the 72 h transmission window (ADR-0008). */
  issuedAt: Date;
}

/** The outcome stored for an earlier correction request that used an `Idempotency-Key`. */
export interface StoredCorrection {
  documentId: string;
  cdc: string;
  requestHash: string;
  /** The document a reissue created (`kind = reissue`); `undefined` for a same-CDC correction. */
  replacement?: { documentId: string; cdc: string } | null;
}

export interface CorrectionRewrite {
  document: CorrectableDocument;
  payload: unknown;
  receiverRuc: string | null;
  totalAmount: string;
  idempotencyKey: string;
  requestHash: string;
}

/** The claim a reissue holds on a rejected document while it issues the replacement (ADR-0021). */
export interface CorrectionClaim {
  idempotencyKey: string;
  requestHash: string;
}

export interface CorrectionReissue {
  document: CorrectableDocument;
  replacementDocumentId: string;
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
  /** The document that replaced this one in a reissue, or null. */
  findReissue(documentId: string): Promise<{ documentId: string; cdc: string } | null>;
  /**
   * Links the rejected document to its replacement in the history (`kind = reissue`).
   * @throws IdempotencyKeyCollisionError when the key was taken by a concurrent commit.
   */
  recordReissue(change: CorrectionReissue): Promise<void>;
  /** The claim a reissue holds on the document, or null: at most one correction is in flight (ADR-0021). */
  findClaim(documentId: string): Promise<CorrectionClaim | null>;
  /** Claims the locked document for a reissue; the claim outlives this transaction. */
  claimDocument(claim: CorrectionClaim & { document: CorrectableDocument }): Promise<void>;
  /** Releases the claim of a reissue that failed before issuing its replacement. */
  releaseClaim(documentId: string): Promise<void>;
}

export interface CorrectionUnitOfWork {
  run<T>(tenantId: string, work: (unit: CorrectionUnit) => Promise<T>): Promise<T>;
}
