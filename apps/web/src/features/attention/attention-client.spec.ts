import { describe, expect, it, vi } from 'vitest';

import type { FetchLike } from '../documents/documents-client';
import { createAttentionClient } from './attention-client';
import { ATTENTION } from './attention-fixtures';

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
  return { fetchImpl, ensureSession, client: createAttentionClient({ fetchImpl, ensureSession }) };
}

describe('attention client', () => {
  it('requests the same-origin attention route with the session cookies', async () => {
    const { client, fetchImpl } = setup(json(ATTENTION));

    expect(await client.get()).toEqual({ kind: 'ok', page: ATTENTION });
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe('/api/portal/attention');
    expect(init).toMatchObject({ method: 'GET', credentials: 'include' });
  });

  it('retries once after the session is refreshed and logs out when it is gone', async () => {
    const retried = setup(json({}, 401), json(ATTENTION));
    expect(await retried.client.get()).toEqual({ kind: 'ok', page: ATTENTION });
    expect(retried.ensureSession).toHaveBeenCalledOnce();

    const gone = setup(json({}, 401));
    gone.ensureSession.mockResolvedValueOnce(false);
    expect(await gone.client.get()).toEqual({ kind: 'unauthenticated' });
  });

  it('answers unavailable on a server error, a network error or a malformed body', async () => {
    expect(await setup(json({}, 500)).client.get()).toEqual({ kind: 'unavailable' });
    expect(await setup(new Error('offline')).client.get()).toEqual({ kind: 'unavailable' });
    expect(await setup(json({ items: 'x' })).client.get()).toEqual({ kind: 'unavailable' });
    const unknownReason = { ...ATTENTION, items: [{ ...ATTENTION.items[0], reasons: ['x'] }] };
    expect(await setup(json(unknownReason)).client.get()).toEqual({ kind: 'unavailable' });
  });
});
