import type { ReceivedDocument } from '../../domain/received-document.js';

/**
 * Business fields of a received document. Every field is nullable because extraction can be
 * partial. Money and quantities are decimal STRINGS (ADR-0018), never `number`; the store keeps
 * `numeric(23,8)` so a value reads back padded to 8 decimals ('10' -> '10.00000000'), which
 * compares equal as a decimal.
 */
export interface ReceivedDocumentHeader {
  readonly documentType: number | null;
  readonly cdc: string | null;
  readonly timbrado: string | null;
  readonly establishmentCode: string | null;
  readonly expeditionPointCode: string | null;
  readonly documentNumber: string | null;
  readonly series: string | null;
  readonly issuerRucBase: string | null;
  readonly issuerRucDv: number | null;
  readonly issuerLegalName: string | null;
  readonly issuerTradeName: string | null;
  readonly issuerAddress: string | null;
  readonly issuerEconomicActivity: string | null;
  readonly receiverRucBase: string | null;
  readonly receiverRucDv: number | null;
  readonly receiverLegalName: string | null;
  readonly receiverType: number | null;
  readonly issuedAt: Date | null;
  /** ISO calendar dates (YYYY-MM-DD). */
  readonly dueOn: string | null;
  readonly paidOn: string | null;
  readonly paymentCondition: 'cash' | 'credit' | null;
  readonly creditTermDays: number | null;
  readonly paymentMethod: string | null;
  /** ISO 4217; the store defaults a missing value to PYG. */
  readonly currency: string;
  readonly exchangeRate: string | null;
  readonly totalExempt: string | null;
  readonly totalZeroRated: string | null;
  readonly taxable5: string | null;
  readonly taxable10: string | null;
  readonly vat5: string | null;
  readonly vat10: string | null;
  readonly totalVat: string | null;
  readonly totalDiscount: string | null;
  readonly totalAmount: string | null;
  readonly totalPyg: string | null;
  readonly sifenStatus: string;
  readonly sifenAuthorizedAt: Date | null;
  readonly sifenProtocolNumber: string | null;
  /** Raw parsed rDE or raw model output; never logged. */
  readonly rawData: unknown;
  /** A plain machine code, never free text. */
  readonly extractionErrorCode: string | null;
  /** Portal user id or API key id that confirmed the document. */
  readonly confirmedBy: string | null;
}

/** Header fields supplied when creating or patching; omitted fields keep their default or value. */
export type ReceivedDocumentHeaderInput = Partial<ReceivedDocumentHeader>;

export interface ReceivedDocumentItem {
  /** 1-based line order inside the document. */
  readonly position: number;
  readonly description: string | null;
  readonly productCode: string | null;
  readonly quantity: string | null;
  readonly unitOfMeasure: string | null;
  readonly unitPrice: string | null;
  readonly discount: string | null;
  readonly subtotal: string | null;
  readonly vatRate: 0 | 5 | 10 | null;
  readonly taxableBase: string | null;
  readonly vatAmount: string | null;
}

export interface FieldConfidence {
  readonly fieldName: string;
  /** Decimal string in [0, 1]. */
  readonly confidence: string;
  readonly extractedValue: string | null;
  readonly correctedValue: string | null;
  readonly correctedBy: string | null;
  readonly correctedAt: Date | null;
}

/** Metadata of the stored upload; the bytes live in object storage, never here. */
export interface NewReceivedArtifact {
  readonly storageKey: string;
  readonly contentType: string | null;
  /** Lowercase hex SHA-256: the per-tenant upload dedupe key. */
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly originalName: string | null;
  readonly pageCount: number | null;
}

export interface ReceivedArtifact extends NewReceivedArtifact {
  readonly id: string;
}

export interface NewReceivedDocument {
  /** Aggregate built by `createReceivedDocument`; its id and tenant must match the call. */
  readonly document: ReceivedDocument;
  readonly header?: ReceivedDocumentHeaderInput;
  readonly items?: readonly ReceivedDocumentItem[];
  readonly confidences?: readonly FieldConfidence[];
  readonly artifact?: NewReceivedArtifact;
}

export interface ReceivedDocumentGraph {
  readonly document: ReceivedDocument;
  readonly header: ReceivedDocumentHeader;
  readonly items: readonly ReceivedDocumentItem[];
  readonly confidences: readonly FieldConfidence[];
  readonly artifact: ReceivedArtifact | null;
}

/** `created: false` means a document with the same CDC, number or artifact already existed. */
export interface CreateReceivedDocumentResult {
  readonly created: boolean;
  readonly document: ReceivedDocument;
}

export interface ArtifactMatch {
  readonly artifact: ReceivedArtifact;
  /** The document linked to the artifact, or null when the upload was stored but never attached. */
  readonly document: ReceivedDocument | null;
}

/** Non-aggregate columns that change together with a state transition. */
export interface StateChange {
  readonly header?: ReceivedDocumentHeaderInput;
}

/** The stored version differs from the one the caller read; nothing was written. */
export class VersionConflictError extends Error {
  constructor(
    readonly documentId: string,
    readonly expectedVersion: number,
  ) {
    super(`received document ${documentId} is no longer at version ${String(expectedVersion)}`);
    this.name = 'VersionConflictError';
  }
}

/** The document does not exist for the tenant (also what another tenant's id looks like). */
export class ReceivedDocumentNotFoundError extends Error {
  constructor(readonly documentId: string) {
    super(`received document ${documentId} not found`);
    this.name = 'ReceivedDocumentNotFoundError';
  }
}

/** Every method runs in its own tenant transaction; `tenantId` always comes first. */
export interface ReceivedDocumentRepository {
  /**
   * Persists header, items, confidences and the optional artifact atomically. On a duplicate
   * (same CDC, same issuer/timbrado/number, or an artifact already attached to a document) nothing
   * is written and the existing document is returned with `created: false`.
   */
  create(tenantId: string, input: NewReceivedDocument): Promise<CreateReceivedDocumentResult>;

  load(tenantId: string, id: string): Promise<ReceivedDocumentGraph | null>;

  findByCdc(tenantId: string, cdc: string): Promise<ReceivedDocument | null>;

  findArtifactBySha256(tenantId: string, sha256: string): Promise<ArtifactMatch | null>;

  /**
   * Writes the aggregate state columns (status, needs_review, reasons, version, confirmed_at,
   * confidence, extraction attempts) only if the stored version is still `expectedVersion`.
   *
   * @throws VersionConflictError when it is not (no partial write).
   * @throws ReceivedDocumentNotFoundError when the document does not exist for the tenant.
   */
  save(
    tenantId: string,
    document: ReceivedDocument,
    expectedVersion: number,
    change?: StateChange,
  ): Promise<void>;
}
