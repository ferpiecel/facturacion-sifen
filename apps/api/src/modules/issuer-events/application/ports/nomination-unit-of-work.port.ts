import type { AuditEntry } from '../../../audit/application/ports/record-audit.port.js';
import type { NominationReceiver } from '../../domain/nominate-rules.js';
import type { Environment, StoredEvent } from './cancellation-unit-of-work.port.js';

/** The FE a nomination targets, as the tenant stored it. */
export interface NominationTarget {
  id: string;
  cdc: string;
  environment: Environment;
  documentType: number;
  status: string;
  /** `receiver.kind` of the stored request; null when the payload does not carry one. */
  receiverKind: 'unnamed' | 'named' | null;
}

export interface NewNomination {
  environment: Environment;
  documentId: string;
  reason: string;
  receiver: NominationReceiver;
  idempotencyKey: string;
  requestHash: string;
}

/** Operations that must share one tenant transaction. */
export interface NominationUnit {
  findByIdempotencyKey(key: string): Promise<StoredEvent | null>;
  /** The tenant's document, locked with `FOR NO KEY UPDATE` until the transaction ends, or null. */
  lockDocument(documentId: string): Promise<NominationTarget | null>;
  /** The nomination of this document that is not rejected (4453). */
  findOpenNomination(documentId: string): Promise<{ eventId: string } | null>;
  /**
   * Takes the next event id of the tenant and stores the nomination `pending`.
   * @throws EventKeyCollisionError when the key was taken by a concurrent commit.
   */
  insertNomination(event: NewNomination): Promise<{ id: string }>;
  recordAudit(entry: AuditEntry): Promise<void>;
}

export interface NominationUnitOfWork {
  run<T>(tenantId: string, work: (unit: NominationUnit) => Promise<T>): Promise<T>;
}
