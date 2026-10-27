import type {
  ConformityType,
  PriorReceiverEvent,
  ReceiverEventKind,
} from '../../domain/receiver-event-rules.js';
import type { AuditEntry } from '../../../audit/application/ports/record-audit.port.js';
import type { Environment } from './cancellation-unit-of-work.port.js';

/** The fields of a receiver event its XML needs, as stored in `issuer_events.receiver_data`. */
export interface ReceiverEventData {
  issuedAt: string;
  /** ISO instant of SIFEN's approval of a DTE. */
  approvedAt?: string;
  receivedAt?: string;
  conformityType?: ConformityType;
  estimatedReceiptAt?: string;
  totalPyg?: number;
  /** The tenant as receiver, copied when the event is requested (unawareness and notice). */
  receiver?: { ruc: string; name: string };
}

export interface NewReceiverEvent {
  environment: Environment;
  kind: ReceiverEventKind;
  cdc: string;
  /** `mOtEve`; null on a conformity and a receipt notice. */
  reason: string | null;
  data: ReceiverEventData;
  idempotencyKey: string;
  requestHash: string;
}

/** The unique index of open receiver events refused the insert: a concurrent request registered it first. */
export class ReceiverEventDuplicateError extends Error {
  constructor() {
    super('An open receiver event of this kind already exists for the CDC');
    this.name = 'ReceiverEventDuplicateError';
  }
}

/** Operations that must share one tenant transaction. */
export interface ReceiverEventUnit {
  /** Serializes concurrent registrations over one CDC of the tenant until the transaction ends. */
  lockCdc(cdc: string): Promise<void>;
  /** The tenant's current environment and its RUC and legal name; `party` is null without a fiscal profile. */
  receiverIdentity(): Promise<{
    environment: Environment;
    party: { ruc: string; name: string } | null;
  }>;
  /** Receiver events of the CDC that SIFEN has not refused (every status but `rejected`). */
  listEvents(cdc: string, environment: Environment): Promise<PriorReceiverEvent[]>;
  /**
   * Takes the next event id of the tenant and stores the event `pending`.
   * @throws ReceiverEventDuplicateError when an open event of that kind already exists.
   */
  insertEvent(event: NewReceiverEvent): Promise<{ id: string }>;
  recordAudit(entry: AuditEntry): Promise<void>;
}

export interface ReceiverEventUnitOfWork {
  run<T>(tenantId: string, work: (unit: ReceiverEventUnit) => Promise<T>): Promise<T>;
}
