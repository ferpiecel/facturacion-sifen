import type { ReceivedDocument } from '../../domain/received-document.js';
import type { ReceivedDocumentSource } from '../../domain/source.js';
import type { ReceivedDocumentStatus } from '../../domain/received-document-status.js';
import type {
  ReceivedDocumentGraph,
  ReceivedDocumentHeader,
} from './received-document-repository.port.js';

/** Keyset position: the last row of the previous page, in the store's own precision. */
export interface ReceivedDocumentListCursor {
  /** `created_at` exactly as the store printed it (microseconds survive; a `Date` would not). */
  readonly createdAt: string;
  readonly id: string;
}

export interface ReceivedDocumentListQuery {
  /** Rows to return; the adapter returns up to `limit + 1` so the caller can tell if more exist. */
  readonly limit: number;
  readonly after?: ReceivedDocumentListCursor;
  readonly status?: ReceivedDocumentStatus;
  readonly source?: ReceivedDocumentSource;
  /** RUC without the check digit. */
  readonly issuerRucBase?: string;
  /** Inclusive lower bound on the issue instant. */
  readonly issuedFrom?: Date;
  /** Exclusive upper bound on the issue instant. */
  readonly issuedBefore?: Date;
  readonly isOwnReceiver?: boolean;
  /** Digits only. */
  readonly cdcPrefix?: string;
  /** Inclusive lower bound on `updated_at`. */
  readonly updatedSince?: Date;
}

/** The header columns a list row needs; never the raw payload. */
export type ReceivedDocumentSummaryHeader = Pick<
  ReceivedDocumentHeader,
  | 'documentType'
  | 'cdc'
  | 'establishmentCode'
  | 'expeditionPointCode'
  | 'documentNumber'
  | 'issuerRucBase'
  | 'issuerRucDv'
  | 'issuerLegalName'
  | 'issuedAt'
  | 'currency'
  | 'totalVat'
  | 'totalAmount'
  | 'confirmedBy'
>;

export interface ReceivedDocumentSummary {
  readonly document: ReceivedDocument;
  readonly header: ReceivedDocumentSummaryHeader;
  readonly hasArtifact: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  /** Cursor key of this row; see {@link ReceivedDocumentListCursor}. */
  readonly createdAtKey: string;
}

export interface ReceivedDocumentDetail extends ReceivedDocumentGraph {
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** Read models of the reception module. Every method runs in its own tenant transaction. */
export interface ReceivedDocumentQuery {
  /** Newest first, ordered by (created_at desc, id desc). */
  list(tenantId: string, query: ReceivedDocumentListQuery): Promise<ReceivedDocumentSummary[]>;
  find(tenantId: string, id: string): Promise<ReceivedDocumentDetail | null>;
}
