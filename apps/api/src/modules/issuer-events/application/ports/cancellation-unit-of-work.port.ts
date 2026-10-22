import type { AuditEntry } from '../../../audit/application/ports/record-audit.port.js';

export type Environment = 'test' | 'production';

/** The document a cancellation targets, as the tenant stored it. */
export interface CancellationTarget {
  id: string;
  cdc: string;
  environment: Environment;
  documentType: number;
  status: string;
  approvedAt: Date | null;
  signedAt: Date | null;
}

export interface NewCancellation {
  environment: Environment;
  documentId: string;
  reason: string;
  idempotencyKey: string;
  requestHash: string;
}

/** An event stored by an earlier request that used the same `Idempotency-Key`. */
export interface StoredEvent {
  eventId: string;
  documentId: string | null;
  requestHash: string;
}

/**
 * Another transaction committed an event with the same tenant and `Idempotency-Key` first. The losing
 * transaction rolls back (burning no event id); the use case then re-reads the key.
 */
export class EventKeyCollisionError extends Error {
  constructor() {
    super('Idempotency key already used by a concurrent request');
    this.name = 'EventKeyCollisionError';
  }
}

/** Operations that must share one tenant transaction. */
export interface CancellationUnit {
  findByIdempotencyKey(key: string): Promise<StoredEvent | null>;
  /** The tenant's document, locked with `FOR NO KEY UPDATE` until the transaction ends, or null. */
  lockDocument(documentId: string): Promise<CancellationTarget | null>;
  /**
   * CDCs of the documents associated to `cdc` that still count: approved by SIFEN or still on the
   * way to approval (accepted, signed, queued, submitted). `rejected`, `corrected`, `cancelled` and
   * `number_voided` do not.
   */
  listLiveAssociatedCdcs(cdc: string, environment: Environment): Promise<string[]>;
  /** The cancellation of this document that is not rejected (any status but `rejected`). */
  findOpenCancellation(documentId: string): Promise<{ eventId: string } | null>;
  /**
   * Takes the next event id of the tenant and stores the cancellation `pending`.
   * @throws EventKeyCollisionError when the key was taken by a concurrent commit.
   */
  insertCancellation(event: NewCancellation): Promise<{ id: string }>;
  recordAudit(entry: AuditEntry): Promise<void>;
}

export interface CancellationUnitOfWork {
  run<T>(tenantId: string, work: (unit: CancellationUnit) => Promise<T>): Promise<T>;
}
