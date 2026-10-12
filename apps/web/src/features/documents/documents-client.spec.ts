import { describe, expect, it, vi } from 'vitest';

import { authClient } from '../auth/default-client';
import { createDocumentsClient, type FetchLike } from './documents-client';

vi.mock('../auth/default-client', () => ({ authClient: { me: vi.fn() } }));

const ITEM = {
  id: 'doc-1',
  cdc: '01800123450001001000452022026100214582139077',
  type: 'FE',
  number: '001-001-0004520',
  issuedAt: '2026-10-02T18:42:00Z',
  receiverName: 'ACME S.A.',
  receiverRuc: '80034567-3',
  total: '16100000',
  currency: 'PYG',
  status: 'aprobado',
  hasObservations: false,
};
const PAGE = { items: [ITEM], page: 1, pageSize: 20, total: 1 };

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
  return { fetchImpl, ensureSession, client: createDocumentsClient({ fetchImpl, ensureSession }) };
}

describe('documents client: list', () => {
  it('sends the filters as query params and omits the empty ones', async () => {
    const { client, fetchImpl } = setup(json(PAGE));

    const result = await client.list({
      type: 'FE',
      status: '',
      from: '2026-10-01',
      q: ' 8003 ',
      page: 2,
      pageSize: 20,
    });

    expect(result).toEqual({ kind: 'ok', page: PAGE });
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe('/api/portal/documents?type=FE&from=2026-10-01&q=8003&page=2&pageSize=20');
    expect(init).toMatchObject({ method: 'GET', credentials: 'include' });
  });

  it('asks for the first page of 20 by default', async () => {
    const { client, fetchImpl } = setup(json(PAGE));

    await client.list({});

    expect(fetchImpl.mock.calls[0]?.[0]).toBe('/api/portal/documents?page=1&pageSize=20');
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

  it('answers unavailable (not unauthenticated) when the session check fails transiently', async () => {
    const { client, ensureSession } = setup(json({}, 401));
    ensureSession.mockRejectedValueOnce(new Error('503'));

    expect(await client.list({})).toEqual({ kind: 'unavailable' });
  });

  it('falls back to the item count when the API omits the total', async () => {
    const { client } = setup(json({ items: [ITEM], page: 1, pageSize: 20 }));

    const result = await client.list({});

    expect(result.kind === 'ok' ? result.page.total : -1).toBe(1);
  });

  it('answers unauthenticated when the retry is still 401', async () => {
    const { client, ensureSession } = setup(json({}, 401), json({}, 401));
    ensureSession.mockResolvedValueOnce(true);

    expect(await client.list({})).toEqual({ kind: 'unauthenticated' });
  });

  it.each([
    [500, { kind: 'unavailable' }],
    [429, { kind: 'unavailable' }],
    [400, { kind: 'unavailable' }],
  ])('answers unavailable on a %i', async (status, expected) => {
    const { client } = setup(json({}, status));

    expect(await client.list({})).toEqual(expected);
  });

  it('answers unavailable on a network error or a malformed body', async () => {
    expect(await setup(new Error('offline')).client.list({})).toEqual({ kind: 'unavailable' });
    expect(await setup(json({ nope: true })).client.list({})).toEqual({ kind: 'unavailable' });
  });
});

describe('documents client: detail', () => {
  const DETAIL = {
    ...ITEM,
    environment: 'test',
    events: [{ status: 'aprobado', at: '2026-10-02T18:42:03Z', code: '0260', message: 'ok' }],
    rejectionReason: null,
  };

  it('fetches the document by id', async () => {
    const { client, fetchImpl } = setup(json(DETAIL));

    expect(await client.detail('doc 1')).toEqual({ kind: 'ok', document: DETAIL });
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('/api/portal/documents/doc%201');
  });

  it('answers not_found on a 404', async () => {
    expect(await setup(json({}, 404)).client.detail('x')).toEqual({ kind: 'not_found' });
  });

  it('answers unauthenticated on an unrecoverable 401', async () => {
    expect(await setup(json({}, 401)).client.detail('x')).toEqual({ kind: 'unauthenticated' });
  });
});

describe('documents client: xml and kude', () => {
  it('returns the XML text', async () => {
    const { client, fetchImpl } = setup(new Response('<rDE/>', { status: 200 }));

    expect(await client.xml('d1')).toEqual({ kind: 'ok', xml: '<rDE/>' });
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('/api/portal/documents/d1/xml');
  });

  it('returns the KuDE as a PDF blob', async () => {
    const { client, fetchImpl } = setup(
      new Response('%PDF-1.7', { status: 200, headers: { 'content-type': 'application/pdf' } }),
    );

    const result = await client.kude('d1');

    expect(result.kind).toBe('ok');
    expect(result.kind === 'ok' ? result.pdf.type : '').toBe('application/pdf');
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('/api/portal/documents/d1/kude');
  });

  it('answers not_available when the KuDE is not implemented yet (501)', async () => {
    expect(await setup(json({}, 501)).client.kude('d1')).toEqual({ kind: 'not_available' });
  });

  it('answers not_found for an XML that does not exist', async () => {
    expect(await setup(json({}, 404)).client.xml('d1')).toEqual({ kind: 'not_found' });
  });

  it('exposes same-origin download URLs', () => {
    const { client } = setup();

    expect(client.xmlUrl('a/b')).toBe('/api/portal/documents/a%2Fb/xml');
    expect(client.kudeUrl('d1')).toBe('/api/portal/documents/d1/kude');
  });
});

describe('documents client: default session recovery', () => {
  const me = vi.mocked(authClient.me);
  const client = (...r: Response[]) => createDocumentsClient({ fetchImpl: setup(...r).fetchImpl });

  it('sends the user to the login only when the auth session is really gone', async () => {
    me.mockResolvedValueOnce({ kind: 'unauthenticated' });

    expect(await client(json({}, 401)).list({})).toEqual({ kind: 'unauthenticated' });
  });

  it('keeps the session and reports a retryable error when the check is transient', async () => {
    me.mockResolvedValueOnce({ kind: 'unavailable' });

    expect(await client(json({}, 401)).list({})).toEqual({ kind: 'unavailable' });
  });
});
