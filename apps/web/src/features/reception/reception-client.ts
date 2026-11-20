/**
 * Browser client of the READ-ONLY portal received-documents API (`GET /portal/received-documents[/:id[/artifact]]`, R7.1, R7.1b).
 * Same-origin proxy (`/api/portal/*`, see `security/api-proxy.ts`) and the same 401 recovery as the documents
 * client (one `ensureSession` and one retry). Wire names are the API's snake_case (`received-document.presenter.ts`).
 * There is deliberately no write method: uploads, corrections and reprocessing are API-key only.
 */
import { createPortalHttp, type Failure, type PortalHttpOptions } from '../documents/portal-http';

export type { FetchLike } from '../auth/auth-client';

/** Lifecycle state; the portal maps unknown values to a neutral label. */
export type ReceivedDocumentStatus = string;

export interface ReceivedDocumentSummary {
  id: string;
  status: ReceivedDocumentStatus;
  source: string;
  version: number;
  needs_review: boolean;
  /** `false`: the document was addressed to another receiver. */
  is_own_receiver: boolean;
  document_type: number | null;
  cdc: string | null;
  issuer: { ruc: string | null; name: string | null };
  document_number: string | null;
  /** `YYYY-MM-DD`. */
  issued_on: string | null;
  currency: string | null;
  /** Decimal strings. */
  total_amount: string | null;
  total_vat: string | null;
  confidence_overall: string | null;
  confirmed_at: string | null;
  has_artifact: boolean;
  created_at: string;
  updated_at: string;
}

export interface ReceivedDocumentsPage {
  items: ReceivedDocumentSummary[];
  next_cursor: string | null;
}

export interface ReceivedDocumentItem {
  position: number;
  description: string | null;
  product_code: string | null;
  quantity: string | null;
  unit_of_measure: string | null;
  unit_price: string | null;
  discount: string | null;
  subtotal: string | null;
  vat_rate: number | null;
  taxable_base: string | null;
  vat_amount: string | null;
}

export interface ReceivedFieldConfidence {
  field: string;
  confidence: string | null;
  extracted_value: string | null;
  corrected_value: string | null;
  corrected_by: string | null;
  corrected_at: string | null;
}

/**
 * The detail is NOT a superset of the summary: it has no `has_artifact` (use `artifact`), `total_amount` or
 * `total_vat` (use `totals`), and its `issuer` is richer.
 */
export interface ReceivedDocumentDetail extends Omit<
  ReceivedDocumentSummary,
  'issuer' | 'has_artifact' | 'total_amount' | 'total_vat'
> {
  needs_review_reasons: string[];
  extraction_error_code: string | null;
  extraction_attempts: number;
  timbrado: string | null;
  series: string | null;
  establishment_code: string | null;
  expedition_point_code: string | null;
  document_sequence: string | null;
  exchange_rate: string | null;
  issuer: {
    ruc: string | null;
    ruc_base: string | null;
    ruc_dv: number | null;
    legal_name: string | null;
    trade_name: string | null;
    address: string | null;
    economic_activity: string | null;
  };
  receiver: {
    ruc: string | null;
    ruc_base: string | null;
    ruc_dv: number | null;
    legal_name: string | null;
    type: number | null;
  };
  payment: {
    condition: number | null;
    credit_term_days: number | null;
    method: string | null;
    due_on: string | null;
    paid_on: string | null;
  };
  totals: Record<
    | 'exempt'
    | 'zero_rated'
    | 'taxable_5'
    | 'taxable_10'
    | 'vat_5'
    | 'vat_10'
    | 'total_vat'
    | 'discount'
    | 'total_amount'
    | 'total_pyg',
    string | null
  >;
  sifen: { status: string | null; authorized_at: string | null; protocol_number: string | null };
  items: ReceivedDocumentItem[];
  field_confidences: ReceivedFieldConfidence[];
  confirmed_by: string | null;
  corrected_at: string | null;
  corrected_by: string | null;
  artifact: {
    id: string;
    content_type: string;
    size_bytes: number;
    sha256: string;
    original_name: string | null;
    page_count: number | null;
  } | null;
  /** API path (`/portal/received-documents/:id/artifact`) of the stored artifact, or `null` without one. */
  artifact_url: string | null;
}

/** Filters of the list; camelCase here, snake_case on the wire. Empty values are omitted. */
export interface ReceivedDocumentsQuery {
  status?: string;
  source?: string;
  issuerRuc?: string;
  /** `YYYY-MM-DD`, inclusive. */
  issuedFrom?: string;
  issuedTo?: string;
  isOwnReceiver?: boolean;
  cdcPrefix?: string;
  cursor?: string;
  limit?: number;
}

export type ReceivedListResult = { kind: 'ok'; page: ReceivedDocumentsPage } | Failure;
export type ReceivedDetailResult =
  { kind: 'ok'; document: ReceivedDocumentDetail } | { kind: 'not_found' } | Failure;

export interface ReceptionClient {
  list: (query: ReceivedDocumentsQuery) => Promise<ReceivedListResult>;
  detail: (id: string) => Promise<ReceivedDetailResult>;
  /** Same-origin URL that streams the stored artifact (session cookie); for an `<a>`, `<img>` or `<iframe>`. */
  artifactUrl: (id: string) => string;
}

type Options = PortalHttpOptions & { baseUrl?: string };

const isPage = (data: unknown): data is ReceivedDocumentsPage =>
  typeof data === 'object' && data !== null && Array.isArray((data as ReceivedDocumentsPage).items);

const isDetail = (data: unknown): data is ReceivedDocumentDetail =>
  typeof data === 'object' &&
  data !== null &&
  Array.isArray((data as ReceivedDocumentDetail).items);

const TEXT_FILTERS = [
  ['status', 'status'],
  ['source', 'source'],
  ['issuerRuc', 'issuer_ruc'],
  ['issuedFrom', 'issued_from'],
  ['issuedTo', 'issued_to'],
  ['cdcPrefix', 'cdc_prefix'],
] as const;

export function createReceptionClient({
  baseUrl = '/api/portal/received-documents',
  ...http
}: Options = {}): ReceptionClient {
  const { run } = createPortalHttp(http);

  return {
    artifactUrl: (id) => `${baseUrl}/${encodeURIComponent(id)}/artifact`,

    list: (query) => {
      const params = new URLSearchParams();
      for (const [key, wire] of TEXT_FILTERS) {
        const value = query[key]?.trim();
        if (value) params.set(wire, value);
      }
      if (query.isOwnReceiver !== undefined) {
        params.set('is_own_receiver', String(query.isOwnReceiver));
      }
      const cursor = query.cursor?.trim();
      if (cursor) params.set('cursor', cursor);
      if (query.limit !== undefined) params.set('limit', String(query.limit));
      const qs = params.toString();
      return run<ReceivedListResult>(qs ? `${baseUrl}?${qs}` : baseUrl, async (response) => {
        if (!response.ok) return { kind: 'unavailable' };
        const data: unknown = await response.json();
        return isPage(data)
          ? { kind: 'ok', page: { ...data, next_cursor: data.next_cursor ?? null } }
          : { kind: 'unavailable' };
      });
    },

    detail: (id) =>
      run<ReceivedDetailResult>(`${baseUrl}/${encodeURIComponent(id)}`, async (response) => {
        if (response.status === 404) return { kind: 'not_found' };
        if (!response.ok) return { kind: 'unavailable' };
        const data: unknown = await response.json();
        return isDetail(data) ? { kind: 'ok', document: data } : { kind: 'unavailable' };
      }),
  };
}

/** The shared browser client of the received documents screens. */
export const receptionClient = createReceptionClient();
