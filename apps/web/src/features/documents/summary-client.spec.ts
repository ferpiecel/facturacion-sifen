import { describe, expect, it, vi } from 'vitest';

import type { FetchLike } from './documents-client';
import { createSummaryClient } from './summary-client';
import { SUMMARY } from './summary-fixtures';

vi.mock('../auth/default-client', () => ({ authClient: { me: vi.fn() } }));

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function setup(...responses: (Response | Error)[]) {
  const queue = [...responses];
  const fetchImpl = vi.fn<FetchLike>(() => {
    const next = queue.shift();
    if (next === undefined) throw new Error('unexpected request');
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  });
  const ensureSession = vi.fn(() => Promise.resolve(true));
  return { fetchImpl, ensureSession, client: createSummaryClient({ fetchImpl, ensureSession }) };
}

describe('summary client', () => {
  it('sends the period as query params and returns the summary', async () => {
    const { client, fetchImpl } = setup(json(SUMMARY));

    const result = await client.get({ from: '2026-09-13', to: '2026-10-12' });

    expect(result).toEqual({ kind: 'ok', summary: SUMMARY });
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe('/api/portal/summary?from=2026-09-13&to=2026-10-12');
    expect(init).toMatchObject({ method: 'GET', credentials: 'include' });
  });

  it('omits the period to let the API default to the last 30 days', async () => {
    const { client, fetchImpl } = setup(json(SUMMARY));

    await client.get({});

    expect(fetchImpl.mock.calls[0]?.[0]).toBe('/api/portal/summary');
  });

  it('retries once after the session is refreshed', async () => {
    const { client, ensureSession } = setup(json({}, 401), json(SUMMARY));

    expect(await client.get({})).toEqual({ kind: 'ok', summary: SUMMARY });
    expect(ensureSession).toHaveBeenCalledOnce();
  });

  it('answers unauthenticated when the session is gone', async () => {
    const { client, ensureSession } = setup(json({}, 401));
    ensureSession.mockResolvedValueOnce(false);

    expect(await client.get({})).toEqual({ kind: 'unauthenticated' });
  });

  it('answers unavailable on a server error, a network error or a malformed body', async () => {
    expect(await setup(json({}, 500)).client.get({})).toEqual({ kind: 'unavailable' });
    expect(await setup(new Error('offline')).client.get({})).toEqual({ kind: 'unavailable' });
    expect(await setup(json({ totals: null })).client.get({})).toEqual({ kind: 'unavailable' });
  });

  it('answers unavailable for a partial summary instead of letting it reach the screen', async () => {
    const partials = [
      { ...SUMMARY, totals: { count: 1, otherCurrencyCount: 0 } },
      { ...SUMMARY, rejected: { count: 1 } },
      { ...SUMMARY, previous: {} },
      { ...SUMMARY, pending: { count: 1, overdue: 0, dueSoon: 0 } },
      { ...SUMMARY, byStatus: [{ status: 'approved', count: 'x' }] },
    ];
    for (const body of partials) {
      expect(await setup(json(body)).client.get({})).toEqual({ kind: 'unavailable' });
    }
  });
});
