import type {
  EventSigner,
  EventXmlBuilder,
  IssuerEvent,
  ReceiverEvent,
} from '@sifen/sifen-gateway';
import type { CertificateSource } from '../../emission/application/ports/signing.port.js';
import type { TenantEnvironment } from '../../fiscal-config/domain/document-environment.js';

/** The stored range of a voiding (`issuer_events.void_range`). */
export interface StoredVoidRange {
  readonly timbrado: string;
  readonly establishment: string;
  readonly point: string;
  readonly from: number;
  readonly to: number;
  readonly type: number;
  readonly series?: string;
}

/** `issuer_events.receiver_data` of a receiver event (HU-E9-01). */
export interface StoredReceiverData {
  readonly issuedAt: string;
  readonly receivedAt?: string;
  readonly conformityType?: 'total' | 'partial';
  readonly estimatedReceiptAt?: string;
  readonly totalPyg?: number;
  readonly receiver?: { readonly ruc: string; readonly name: string };
}

/** A stored issuer event with what is needed to build its XML. */
export interface EventToSign {
  readonly id: string;
  readonly status: string;
  readonly environment: TenantEnvironment;
  readonly tenantEnvironment: TenantEnvironment;
  readonly eventId: bigint;
  readonly kind: string;
  /** `mOtEve`; null only on the receiver events that carry none. */
  readonly reason: string | null;
  /** CDC of the targeted document (cancellation, nomination) or of the foreign DE/DTE (receiver events); null for a voiding. */
  readonly cdc: string | null;
  readonly voidRange: StoredVoidRange | null;
  readonly receiverData: StoredReceiverData | null;
}

/** Persistence of the events waiting to be signed; implemented over `issuer_events`. */
export interface EventSigningStore {
  /** `pending` events of the tenant's current environment, oldest first. */
  pendingEventIds(limit: number): Promise<readonly string[]>;
  /** Parks a `pending` event for an operator (marked by its reason): `pendingEventIds` no longer lists it. */
  holdEvent(eventId: string, reason: string): Promise<void>;
  load(eventId: string): Promise<EventToSign | undefined>;
  /** Atomically `pending -> signed`; false when the event is no longer pending. */
  markSigned(eventId: string, signed: { signedXml: string; signedAt: Date }): Promise<boolean>;
}

export class EventNotFoundError extends Error {
  constructor() {
    super('issuer event not found');
    this.name = 'EventNotFoundError';
  }
}

export class EventIdOutOfRangeError extends Error {
  constructor() {
    super('issuer event id is beyond the safe integer range');
    this.name = 'EventIdOutOfRangeError';
  }
}

export class EventEnvironmentMismatchError extends Error {
  constructor() {
    super('issuer event environment differs from the tenant environment');
    this.name = 'EventEnvironmentMismatchError';
  }
}

/** The event kind has no XML builder yet (nomination arrives with HU-E8-05). */
export class EventKindNotSignableError extends Error {
  constructor(kind: string) {
    super(`issuer events of kind ${kind} cannot be signed yet`);
    this.name = 'EventKindNotSignableError';
  }
}

/** The stored event lacks the document or the range its kind needs. */
export class EventDataIncompleteError extends Error {
  constructor() {
    super('issuer event is missing its document or range');
    this.name = 'EventDataIncompleteError';
  }
}

export interface SignPendingEventDeps {
  readonly store: EventSigningStore;
  readonly certificates: CertificateSource;
  readonly builder: EventXmlBuilder;
  readonly signer: EventSigner;
  readonly now?: () => Date;
}

export type SignPendingEventResult =
  | { readonly status: 'signed' }
  /** Nothing to do: the event is not (or no longer) `pending`. */
  | { readonly status: 'skipped'; readonly eventStatus: string };

function toIssuerEvent(event: EventToSign): IssuerEvent | ReceiverEvent {
  if (event.kind === 'cancellation') {
    if (event.cdc === null || event.reason === null) throw new EventDataIncompleteError();
    return { kind: 'cancellation', cdc: event.cdc, reason: event.reason };
  }
  if (event.kind === 'voiding') {
    const range = event.voidRange;
    if (range === null || event.reason === null) throw new EventDataIncompleteError();
    return {
      kind: 'voiding',
      timbrado: range.timbrado,
      establishment: range.establishment,
      expeditionPoint: range.point,
      from: range.from,
      to: range.to,
      documentType: range.type,
      reason: event.reason,
      ...(range.series === undefined ? {} : { series: range.series }),
    };
  }
  return toReceiverEvent(event);
}

const RECEIVER_KINDS = ['conformity', 'disconformity', 'unawareness', 'receipt_notice'];

function toReceiverEvent(event: EventToSign): IssuerEvent | ReceiverEvent {
  if (!RECEIVER_KINDS.includes(event.kind)) throw new EventKindNotSignableError(event.kind);
  const data = event.receiverData;
  if (event.cdc === null || data === null) throw new EventDataIncompleteError();
  const { cdc, reason } = event;
  switch (event.kind) {
    case 'conformity':
      if (!data.conformityType) throw new EventDataIncompleteError();
      return {
        kind: 'conformity',
        cdc,
        conformityType: data.conformityType,
        ...(data.estimatedReceiptAt ? { estimatedReceiptAt: data.estimatedReceiptAt } : {}),
      };
    case 'disconformity':
      if (reason === null) throw new EventDataIncompleteError();
      return { kind: 'disconformity', cdc, reason };
    case 'unawareness':
      if (reason === null || !data.receivedAt || !data.receiver)
        throw new EventDataIncompleteError();
      return {
        kind: 'unawareness',
        cdc,
        reason,
        issuedAt: data.issuedAt,
        receivedAt: data.receivedAt,
        receiver: data.receiver,
      };
    case 'receipt_notice':
      if (!data.receivedAt || !data.receiver || data.totalPyg === undefined)
        throw new EventDataIncompleteError();
      return {
        kind: 'receipt_notice',
        cdc,
        issuedAt: data.issuedAt,
        receivedAt: data.receivedAt,
        totalPyg: data.totalPyg,
        receiver: data.receiver,
      };
    default:
      throw new EventKindNotSignableError(event.kind);
  }
}

/**
 * Signs a `pending` issuer event with the tenant's certificate for the event's environment (HU-E8-04,
 * ADR-0020) and stores it `pending -> signed` in one store call, so any failure before it leaves the event
 * `pending`. The `.p12` only lives in memory and is zeroized however the run ends. The signing instant is
 * the one the event carries (`dFecFirma`, Asunción time).
 *
 * @throws EventNotFoundError, EventIdOutOfRangeError, EventEnvironmentMismatchError, EventKindNotSignableError,
 *   EventDataIncompleteError, and the certificate source's typed errors.
 */
export class SignPendingEvent {
  constructor(private readonly deps: SignPendingEventDeps) {}

  async execute({
    tenantId,
    eventId,
  }: {
    readonly tenantId: string;
    readonly eventId: string;
  }): Promise<SignPendingEventResult> {
    const event = await this.deps.store.load(eventId);
    if (!event) throw new EventNotFoundError();
    if (event.status !== 'pending') return { status: 'skipped', eventStatus: event.status };
    if (event.environment !== event.tenantEnvironment) throw new EventEnvironmentMismatchError();
    if (event.eventId > BigInt(Number.MAX_SAFE_INTEGER)) throw new EventIdOutOfRangeError();
    const issuerEvent = toIssuerEvent(event);

    const signedAt = (this.deps.now ?? (() => new Date()))();
    const certificate = await this.deps.certificates.open(tenantId, event.environment);
    try {
      const unsigned = await this.deps.builder.build({
        eventId: Number(event.eventId),
        event: issuerEvent,
        signedAt,
      });
      const signedXml = await this.deps.signer.sign(unsigned, {
        p12: certificate.p12,
        password: certificate.password,
      });
      const stored = await this.deps.store.markSigned(eventId, { signedXml, signedAt });
      return stored ? { status: 'signed' } : { status: 'skipped', eventStatus: 'signed' };
    } finally {
      certificate.p12.fill(0);
    }
  }
}
