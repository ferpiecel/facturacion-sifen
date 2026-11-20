import { describe, expect, it, vi } from 'vitest';

import { authClient } from '../auth/default-client';
import { createReceptionClient, type FetchLike } from './reception-client';

vi.mock('../auth/default-client', () => ({ authClient: { me: vi.fn() } }));

const ITEM = {
  id: '0b9f5c1e-0000-4000-8000-000000000001',
  status: 'extracted',
  source: 'upload',
  version: 1,
  needs_review: false,
  is_own_receiver: true,
  document_type: 1,
  cdc: '01800123450001001000452022026100214582139077',
  issuer: { ruc: '80012345-6', name: 'Proveedor S.A.' },
  document_number: '001-001-0004520',
  issued_on: '2026-10-02',
  currency: 'PYG',
  total_amount: '16100000',
  total_vat: '1463636',
  confidence_overall: '0.97',
  confirmed_at: null,
  has_artifact: true,
  created_at: '2026-10-02T18:42:00.000Z',
  updated_at: '2026-10-02T18:42:03.000Z',
};
const PAGE = { items: [ITEM], next_cursor: 'abc' };

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function setup(...responses: (Response | Error)[]) {
  const queue = [...responses];
  const fetchImpl = vi.fn<FetchLike>(() => {
    const next = queue.shift();
    if (next === undefined) throw new Error('unexpected request');
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  });
  const ensureSession = vi.fn(() => Promise.resolve(false));
  return { fetchImpl, ensureSession, client: createReceptionClient({ fetchImpl, ensureSession }) };
}

describe('reception client: list', () => {
  it('sends the filters and the cursor as query params and omits the empty ones', async () => {
    const { client, fetchImpl } = setup(json(PAGE));

    const result = await client.list({
      status: 'needs_review',
      source: '',
      issuedFrom: '2026-10-01',
      issuedTo: '2026-10-31',
      issuerRuc: ' 80012345-6 ',
      isOwnReceiver: false,
      cursor: 'abc',
      limit: 10,
    });

    expect(result).toEqual({ kind: 'ok', page: PAGE });
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe(
      '/api/portal/received-documents?status=needs_review&issuer_ruc=80012345-6' +
        '&issued_from=2026-10-01&issued_to=2026-10-31&is_own_receiver=false&cursor=abc&limit=10',
    );
    expect(init).toMatchObject({ method: 'GET', credentials: 'include' });
  });

  it('sends no params by default', async () => {
    const { client, fetchImpl } = setup(json(PAGE));

    await client.list({});

    expect(fetchImpl.mock.calls[0]?.[0]).toBe('/api/portal/received-documents');
  });

  it('answers unauthenticated on a 401 that the session cannot recover', async () => {
    const { client, ensureSession, fetchImpl } = setup(json({}, 401));

    expect(await client.list({})).toEqual({ kind: 'unauthenticated' });
    expect(ensureSession).toHaveBeenCalledOnce();
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('retries once after the session is refreshed', async () => {
    const { client, ensureSession, fetchImpl } = setup(json({}, 401), json(PAGE));
    ensureSession.mockResolvedValueOnce(true);

    expect(await client.list({})).toEqual({ kind: 'ok', page: PAGE });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('answers unauthenticated when the retry is still 401', async () => {
    const { client, ensureSession } = setup(json({}, 401), json({}, 401));
    ensureSession.mockResolvedValueOnce(true);

    expect(await client.list({})).toEqual({ kind: 'unauthenticated' });
  });

  it('answers unavailable (not unauthenticated) when the session check fails transiently', async () => {
    const { client, ensureSession } = setup(json({}, 401));
    ensureSession.mockRejectedValueOnce(new Error('503'));

    expect(await client.list({})).toEqual({ kind: 'unavailable' });
  });

  it.each([500, 503, 429, 400])('answers unavailable on a %i', async (status) => {
    expect(await setup(json({}, status)).client.list({})).toEqual({ kind: 'unavailable' });
  });

  it('answers unavailable on a network error or a malformed body', async () => {
    expect(await setup(new Error('offline')).client.list({})).toEqual({ kind: 'unavailable' });
    expect(await setup(json({ nope: true })).client.list({})).toEqual({ kind: 'unavailable' });
  });
});

describe('reception client: detail', () => {
  const DETAIL = { ...ITEM, needs_review_reasons: [], items: [], field_confidences: [] };

  it('fetches the document by id', async () => {
    const { client, fetchImpl } = setup(json(DETAIL));

    expect(await client.detail('doc 1')).toEqual({ kind: 'ok', document: DETAIL });
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('/api/portal/received-documents/doc%201');
  });

  it('answers not_found on a 404', async () => {
    expect(await setup(json({}, 404)).client.detail('x')).toEqual({ kind: 'not_found' });
  });

  it('answers unavailable on a 5xx or a body without items', async () => {
    expect(await setup(json({}, 500)).client.detail('x')).toEqual({ kind: 'unavailable' });
    expect(await setup(json({ id: 'x' })).client.detail('x')).toEqual({ kind: 'unavailable' });
  });

  it('answers unauthenticated on an unrecoverable 401', async () => {
    expect(await setup(json({}, 401)).client.detail('x')).toEqual({ kind: 'unauthenticated' });
  });
});

describe('reception client: read-only', () => {
  it('exposes only list and detail, and only issues GET requests', async () => {
    const { client, fetchImpl } = setup(json(PAGE), json({ items: [] }));

    await client.list({});
    await client.detail('d1');

    expect(Object.keys(client).sort()).toEqual(['detail', 'list']);
    expect(fetchImpl.mock.calls.map(([, init]) => init?.method)).toEqual(['GET', 'GET']);
  });
});

describe('reception client: default session recovery', () => {
  const me = vi.mocked(authClient.me);
  const client = (...r: Response[]) => createReceptionClient({ fetchImpl: setup(...r).fetchImpl });

  it('sends the user to the login only when the auth session is really gone', async () => {
    me.mockResolvedValueOnce({ kind: 'unauthenticated' });

    expect(await client(json({}, 401)).list({})).toEqual({ kind: 'unauthenticated' });
  });

  it('keeps the session and reports a retryable error when the check is transient', async () => {
    me.mockResolvedValueOnce({ kind: 'unavailable' });

    expect(await client(json({}, 401)).list({})).toEqual({ kind: 'unavailable' });
  });
});
