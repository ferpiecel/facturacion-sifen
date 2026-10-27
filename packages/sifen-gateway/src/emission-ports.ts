/**
 * Framework-free emission ports for the offline TIPS PoC (HU-E0-04).
 *
 * Implementations MUST NOT import NestJS, Fastify, Drizzle, BullMQ, or any
 * `facturacionelectronicapy-*` (TIPS) library. Only `@sifen/sifen-tips`
 * adapters may depend on the TIPS libraries directly (see the root
 * `.dependency-cruiser.cjs` rule).
 */

/** SIFEN target environment. */
export type Ambiente = 'test' | 'prod';

/**
 * A PKCS#12 certificate held in memory. Adapters whose underlying library only
 * reads from a file path MUST write it to an ephemeral 0600 temp file and delete
 * it in a `finally` block (ADR-0015).
 */
export interface LoadedCertificate {
  readonly p12: Uint8Array;
  readonly password: string;
}

/** Configuration needed to embed the SIFEN QR in a signed DE. */
export interface QrConfig {
  readonly idCsc: string;
  readonly csc: string;
  readonly ambiente: Ambiente;
}

/**
 * Opaque, domain-free input for the offline PoC builder. Replaced by the
 * full `DocumentoElectronico` domain model in E5.
 */
export interface FacturaPocInput {
  readonly params: Readonly<Record<string, unknown>>;
  readonly data: Readonly<Record<string, unknown>>;
  /** Builder options (for xmlgen: decimals and rounding). Omitted means the builder defaults. */
  readonly config?: Readonly<Record<string, unknown>>;
}

/** Builds a signable FE XML document from PoC-level DE data. */
export interface DeXmlBuilder {
  buildParaSifen(input: FacturaPocInput): Promise<string>;
}

/** Signs an FE XML document. Implementations MUST NOT spawn a JVM process. */
export interface XmlSigner {
  sign(xml: string, cert: LoadedCertificate): Promise<string>;
}

/** Embeds the SIFEN QR in a signed FE XML document. */
export interface QrGenerator {
  addQr(signedXml: string, config: QrConfig): Promise<string>;
}

/** Cancellation of an approved DTE (MT 11.5.1, `rGeVeCan`; 5 to 500 characters of reason). */
export interface CancellationEvent {
  readonly kind: 'cancellation';
  readonly cdc: string;
  readonly reason: string;
}

/** Voiding of a range of numbers (MT 11.5.1, `rGeVeInu`; at most 1000 numbers and `to` after `from`, enforced by the builder). */
export interface VoidingEvent {
  readonly kind: 'voiding';
  readonly timbrado: string;
  readonly establishment: string;
  readonly expeditionPoint: string;
  readonly from: number;
  readonly to: number;
  /** `iTiDE` of the voided numbers (1 to 8). */
  readonly documentType: number;
  readonly reason: string;
  readonly series?: string;
}

/** The receiver a nomination names (NT 014, 015, 027); a taxpayer by RUC, anyone else by identity document. */
export type NominationEventReceiver = (
  | { readonly kind: 'taxpayer'; readonly ruc: string; readonly taxpayerType: 1 | 2 }
  | {
      readonly kind: 'non-taxpayer';
      readonly documentType: 1 | 2 | 3 | 4 | 5;
      readonly documentNumber: string;
    }
) & {
  readonly name: string;
  readonly tradeName?: string;
  /** Three-letter country code. */
  readonly country: string;
  readonly operationType: 'B2B' | 'B2C' | 'B2F';
  readonly address?: string;
  readonly houseNumber?: string;
  readonly departmentCode?: number;
  readonly districtCode?: number;
  readonly cityCode?: number;
  readonly phone?: string;
  readonly mobile?: string;
  readonly email?: string;
  readonly customerCode?: string;
};

/** Nomination of an FE issued to an unnamed receiver (MT 11.5.1, `rGEveNom`; reason of 5 to 500 characters). */
export interface NominationEvent {
  readonly kind: 'nomination';
  readonly cdc: string;
  readonly reason: string;
  readonly receiver: NominationEventReceiver;
}

/** Issuer events the platform sends to `siRecepEvento` (HU-E8-04, HU-E8-05). */
export type IssuerEvent = CancellationEvent | VoidingEvent | NominationEvent;

/** The tenant as the receiver of a DE/DTE: a taxpayer (`iTipRec` 1) whose RUC is `base-dv`. */
export interface ReceiverParty {
  readonly ruc: string;
  readonly name: string;
}

/** Conformity of the receiver (MT 11.5, `rGeVeConf`); a partial one carries the estimated receipt date (GCO004). */
export interface ConformityEvent {
  readonly kind: 'conformity';
  readonly cdc: string;
  readonly conformityType: 'total' | 'partial';
  /** `AAAA-MM-DDThh:mm:ss`. */
  readonly estimatedReceiptAt?: string;
}

/** Disconformity (`rGeVeDisconf`; reason of 5 to 500 characters). */
export interface DisconformityEvent {
  readonly kind: 'disconformity';
  readonly cdc: string;
  readonly reason: string;
}

/** Unawareness of a DE/DTE (`rGeVeDescon`). Dates are `AAAA-MM-DDThh:mm:ss`, Asunción time. */
export interface UnawarenessEvent {
  readonly kind: 'unawareness';
  readonly cdc: string;
  readonly reason: string;
  readonly issuedAt: string;
  readonly receivedAt: string;
  readonly receiver: ReceiverParty;
}

/** Receipt notice of a DE/DTE (`rGeVeNotRec`). */
export interface ReceiptNoticeEvent {
  readonly kind: 'receipt_notice';
  readonly cdc: string;
  readonly issuedAt: string;
  readonly receivedAt: string;
  readonly totalPyg: number;
  readonly receiver: ReceiverParty;
}

/** Events the tenant sends as receiver (HU-E9-01). */
export type ReceiverEvent =
  ConformityEvent | DisconformityEvent | UnawarenessEvent | ReceiptNoticeEvent;

export interface IssuerEventBuildInput {
  /** Our identifier of the event (`rEve/@Id`, 1 to 10 digits); SIFEN echoes it in its answer. */
  readonly eventId: number;
  readonly event: IssuerEvent | ReceiverEvent;
  /** `dFecFirma`; the builder uses the current time when omitted. */
  readonly signedAt?: Date;
}

/** Builds the unsigned event group (`gGroupGesEve`): one event, no SOAP envelope. */
export interface EventXmlBuilder {
  build(input: IssuerEventBuildInput): Promise<string>;
}

/**
 * Signs one event group with the issuer's certificate and returns it signed, still as a bare
 * `gGroupGesEve` ready to be one of up to 15 inside a `dEvReg`. Implementations MUST NOT spawn a JVM process.
 */
export interface EventSigner {
  sign(eventXml: string, cert: LoadedCertificate): Promise<string>;
}
