/**
 * Browser client of the read-only portal documents API (`GET /portal/documents[/:id[/xml|/kude]]`, HU-E12-01/02).
 * It calls the same-origin proxy (`/api/portal/*`, see `security/api-proxy.ts`), so the session cookies travel with
 * it. A 401 asks the auth session once to recover (`ensureSession`, by default `authClient.me()`, which refreshes
 * the access token) and retries once; if the session is gone the answer is `unauthenticated` and the screen sends
 * the user back to the login.
 */
import type { FetchLike } from '../auth/auth-client';
import { authClient } from '../auth/default-client';

export type { FetchLike } from '../auth/auth-client';

export type DocumentKind = 'FE' | 'NCE' | 'NDE' | 'AFE';

export interface DocumentItem {
  id: string;
  cdc: string;
  type: DocumentKind;
  /** `establishment-point-number`, as printed on the document. */
  number: string;
  /** ISO instant in UTC; shown in America/Asuncion. */
  issuedAt: string;
  receiverName: string;
  receiverRuc: string | null;
  /** Decimal string in `currency`. */
  total: string;
  currency: string;
  /** SIFEN lifecycle state; the portal maps unknown values to a neutral label. */
  status: string;
  hasObservations: boolean;
}

export interface DocumentEvent {
  status: string;
  at: string;
  code: string | null;
  message: string | null;
}

export interface DocumentDetail extends DocumentItem {
  environment: string;
  events: DocumentEvent[];
  rejectionReason: string | null;
}

export interface DocumentsPage {
  items: DocumentItem[];
  page: number;
  pageSize: number;
  total: number;
}

export interface DocumentsQuery {
  type?: DocumentKind | '';
  status?: string;
  /** `YYYY-MM-DD`, inclusive. */
  from?: string;
  to?: string;
  q?: string;
  page?: number;
  pageSize?: number;
}

export const DEFAULT_PAGE_SIZE = 20;

type Failure = { kind: 'unauthenticated' } | { kind: 'unavailable' };
export type ListResult = { kind: 'ok'; page: DocumentsPage } | Failure;
export type DetailResult =
  { kind: 'ok'; document: DocumentDetail } | { kind: 'not_found' } | Failure;
export type XmlResult = { kind: 'ok'; xml: string } | { kind: 'not_found' } | Failure;
export type KudeResult =
  { kind: 'ok'; pdf: Blob } | { kind: 'not_available' } | { kind: 'not_found' } | Failure;

export interface DocumentsClient {
  list: (query: DocumentsQuery) => Promise<ListResult>;
  detail: (id: string) => Promise<DetailResult>;
  xml: (id: string) => Promise<XmlResult>;
  kude: (id: string) => Promise<KudeResult>;
  /** Same-origin download URLs (the browser sends the cookies). */
  xmlUrl: (id: string) => string;
  kudeUrl: (id: string) => string;
}

interface Options {
  fetchImpl?: FetchLike;
  baseUrl?: string;
  /** Recovers an expired session (refresh); `false` means the user must sign in again. */
  ensureSession?: () => Promise<boolean>;
}

const isPage = (data: unknown): data is DocumentsPage =>
  typeof data === 'object' && data !== null && Array.isArray((data as DocumentsPage).items);

const isDetail = (data: unknown): data is DocumentDetail =>
  typeof data === 'object' && data !== null && Array.isArray((data as DocumentDetail).events);

export function createDocumentsClient({
  fetchImpl = (url, init) => fetch(url, init),
  baseUrl = '/api/portal/documents',
  ensureSession = () => authClient.me().then((result) => result.kind === 'ok'),
}: Options = {}): DocumentsClient {
  const get = (url: string) => fetchImpl(url, { method: 'GET', credentials: 'include' });
  const url = (id: string, suffix = '') => `${baseUrl}/${encodeURIComponent(id)}${suffix}`;

  /** GET with one session recovery on 401; `null` means the session is gone. */
  async function session(target: string): Promise<Response | null> {
    const first = await get(target);
    if (first.status !== 401) return first;
    if (!(await ensureSession())) return null;
    const second = await get(target);
    return second.status === 401 ? null : second;
  }

  /** Runs a request, mapping a lost session and network errors to the shared failures. */
  async function run<T>(
    target: string,
    handle: (response: Response) => Promise<T>,
  ): Promise<T | Failure> {
    try {
      const response = await session(target);
      if (!response) return { kind: 'unauthenticated' };
      return await handle(response);
    } catch {
      return { kind: 'unavailable' };
    }
  }

  return {
    list: (query) => {
      const params = new URLSearchParams();
      for (const key of ['type', 'status', 'from', 'to'] as const) {
        const value = query[key]?.trim();
        if (value) params.set(key, value);
      }
      const text = query.q?.trim();
      if (text) params.set('q', text);
      params.set('page', String(query.page ?? 1));
      params.set('pageSize', String(query.pageSize ?? DEFAULT_PAGE_SIZE));
      return run<ListResult>(`${baseUrl}?${params.toString()}`, async (response) => {
        if (!response.ok) return { kind: 'unavailable' };
        const data: unknown = await response.json();
        return isPage(data) ? { kind: 'ok', page: data } : { kind: 'unavailable' };
      });
    },

    detail: (id) =>
      run<DetailResult>(url(id), async (response) => {
        if (response.status === 404) return { kind: 'not_found' };
        if (!response.ok) return { kind: 'unavailable' };
        const data: unknown = await response.json();
        return isDetail(data) ? { kind: 'ok', document: data } : { kind: 'unavailable' };
      }),

    xml: (id) =>
      run<XmlResult>(url(id, '/xml'), async (response) => {
        if (response.status === 404) return { kind: 'not_found' };
        if (!response.ok) return { kind: 'unavailable' };
        return { kind: 'ok', xml: await response.text() };
      }),

    kude: (id) =>
      run<KudeResult>(url(id, '/kude'), async (response) => {
        if (response.status === 501) return { kind: 'not_available' };
        if (response.status === 404) return { kind: 'not_found' };
        if (!response.ok) return { kind: 'unavailable' };
        return {
          kind: 'ok',
          pdf: new Blob([await response.arrayBuffer()], { type: 'application/pdf' }),
        };
      }),

    xmlUrl: (id) => url(id, '/xml'),
    kudeUrl: (id) => url(id, '/kude'),
  };
}

/** The shared browser client of the documents explorer. */
export const documentsClient = createDocumentsClient();
