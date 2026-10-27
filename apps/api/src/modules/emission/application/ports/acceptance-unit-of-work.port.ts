import type { AssociatedInvoiceFacts } from '../../domain/credit-note-draft.js';
import type { AuditEntry } from '../../../audit/application/ports/record-audit.port.js';

/** Everything the emitter side of a document needs, resolved server-side for one tenant. */
export interface IssuerContext {
  environment: 'test' | 'production';
  /** dRucEm and dDVEmi from the tenant's fiscal profile. */
  rucBase: string;
  rucDv: number;
  /** iTipCont. */
  taxpayerType: 1 | 2;
  timbradoId: string;
  establishmentId: string;
  expeditionPointId: string;
  /**
   * `not_after` of the tenant's active certificate for its environment (HU-E3-03); `null` when it has
   * none (signing then holds the document), absent in fakes that do not care.
   */
  certificateNotAfter?: Date | null;
}

export interface IssuerQuery {
  /** dEst / dPunExp as sent by the integrator. */
  establishmentCode: string;
  expeditionPointCode: string;
  /** Issue date in Paraguay local time, `YYYY-MM-DD`. */
  issueDate: string;
}

export interface NewDocument {
  environment: IssuerContext['environment'];
  cdc: string;
  documentType: number;
  timbradoId: string;
  establishmentId: string;
  expeditionPointId: string;
  /** '' while numbering runs without a series. */
  series: string;
  number: number;
  securityCode: string;
  receiverRuc: string | null;
  issuedAt: Date;
  totalAmount: string;
  currency: string;
  payload: unknown;
  /** CDC of the FE a credit note credits (ADR-0019 D4); absent for an FE. */
  associatedCdc?: string;
  /** `Idempotency-Key` of the request, unique per tenant. */
  idempotencyKey: string;
  /** sha-256 of the canonical validated body. */
  requestHash: string;
}

/** The outcome stored for an earlier request that used an `Idempotency-Key`. */
export interface StoredAcceptance {
  documentId: string;
  cdc: string;
  requestHash: string;
}

/**
 * Another transaction committed a document with the same tenant and
 * `Idempotency-Key` first. The losing transaction rolls back (burning no
 * number); the use case then re-reads the key.
 */
export class IdempotencyKeyCollisionError extends Error {
  constructor() {
    super('Idempotency key already used by a concurrent request');
    this.name = 'IdempotencyKeyCollisionError';
  }
}

/** The FE a credit note is associated to, as the tenant stored it. */
export interface AssociatedInvoice extends Omit<AssociatedInvoiceFacts, 'creditedAmount'> {
  /** The FE's `receiver_ruc`, copied to the credit note (the receiver is the FE's, ADR-0019 D3). */
  receiverRuc: string | null;
}

/** Operations that must share one tenant transaction. */
export interface AcceptanceUnit {
  /** The document an earlier request with this key created, or null. */
  findByIdempotencyKey(key: string): Promise<StoredAcceptance | null>;
  /** The tenant's issuer setup, or null when the point or a valid timbrado does not exist. */
  resolveIssuer(query: IssuerQuery): Promise<IssuerContext | null>;
  /**
   * The tenant's FE with this CDC in `environment`, locked with `FOR NO KEY UPDATE` until the
   * transaction ends, or null when there is none (another tenant's FE is none). Concurrent credit
   * notes of one FE serialize here (ADR-0019 D5). The lock does conflict with `createLote`'s
   * `FOR UPDATE` on the same row, so a credit note waits while a lote is built over that FE; neither
   * side takes another lock while holding this one, so there is no wait cycle (ADR-0019 addendum).
   */
  findAssociatedInvoice(
    cdc: string,
    environment: IssuerContext['environment'],
  ): Promise<AssociatedInvoice | null>;
  /**
   * Sum of F014 of the credit notes of that FE that still count: every status except `cancelled` and
   * `number_voided` (a rejected NCE is resent with the same CDC). Exact decimal text.
   */
  sumCreditNotes(cdc: string, environment: IssuerContext['environment']): Promise<string>;
  nextNumber(
    issuer: IssuerContext,
    documentType: number,
  ): Promise<{ series: string | null; number: number }>;
  /** @throws IdempotencyKeyCollisionError when the key was taken by a concurrent commit. */
  insertDocument(document: NewDocument): Promise<{ id: string }>;
  recordAudit(entry: AuditEntry): Promise<void>;
}

/** Runs `work` in one tenant transaction: it commits or rolls back as a whole (gapless numbering). */
export interface AcceptanceUnitOfWork {
  run<T>(tenantId: string, work: (unit: AcceptanceUnit) => Promise<T>): Promise<T>;
}
