import { describe, expect, it, vi } from 'vitest';

import { createAuthClient, type FetchLike } from './auth-client';

type Reply = { status: number; body?: unknown };

function stub(...replies: Reply[]) {
  const queue = [...replies];
  const fetchImpl = vi.fn<FetchLike>(() => {
    const next = queue.shift();
    if (!next) throw new Error('unexpected request');
    const payload = next.body === undefined ? null : JSON.stringify(next.body);
    return Promise.resolve(new Response(payload, { status: next.status }));
  });
  return fetchImpl;
}

const TENANT = { tenantId: 't1', tenantName: 'Acme', role: 'owner' };

describe('auth client', () => {
  it('posts credentials as JSON through the same-origin proxy and includes cookies', async () => {
    const fetchImpl = stub({ status: 200, body: { status: 'mfa_required' } });
    const client = createAuthClient({ fetchImpl });

    await expect(client.login('a@b.py', 'secret')).resolves.toEqual({ kind: 'mfa_required' });

    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe('/api/auth/login');
    expect(init).toMatchObject({
      method: 'POST',
      credentials: 'include',
      body: JSON.stringify({ email: 'a@b.py', password: 'secret' }),
    });
  });

  it.each([
    [401, 'invalid'],
    [429, 'throttled'],
    [400, 'invalid'],
    [503, 'unavailable'],
  ])('maps a %i login answer to %s', async (status, kind) => {
    const client = createAuthClient({ fetchImpl: stub({ status }) });
    await expect(client.login('a@b.py', 'x')).resolves.toEqual({ kind });
  });

  it('reports unavailable when the network fails', async () => {
    const fetchImpl = vi.fn<FetchLike>(() => Promise.reject(new TypeError('offline')));
    const client = createAuthClient({ fetchImpl });
    await expect(client.login('a@b.py', 'x')).resolves.toEqual({ kind: 'unavailable' });
  });

  it('verifies the MFA code and returns the tenants and the active one', async () => {
    const body = { activeTenant: null, tenants: [TENANT] };
    const client = createAuthClient({ fetchImpl: stub({ status: 200, body }) });
    await expect(client.verifyMfa('123456')).resolves.toEqual({ kind: 'ok', ...body });
  });

  it('does not try to refresh a failed login or MFA attempt', async () => {
    const fetchImpl = stub({ status: 401 });
    const client = createAuthClient({ fetchImpl });
    await client.verifyMfa('123456');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('refreshes once on 401 and retries the original request', async () => {
    const fetchImpl = stub(
      { status: 401 },
      { status: 200, body: { status: 'refreshed' } },
      { status: 200, body: { userId: 'u1', activeTenant: null } },
    );
    const client = createAuthClient({ fetchImpl });

    await expect(client.me()).resolves.toEqual({
      kind: 'ok',
      session: { userId: 'u1', activeTenant: null },
    });
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      '/api/auth/me',
      '/api/auth/refresh',
      '/api/auth/me',
    ]);
  });

  it('answers unauthenticated when the refresh fails, without retrying again', async () => {
    const fetchImpl = stub({ status: 401 }, { status: 401 });
    const client = createAuthClient({ fetchImpl });
    await expect(client.me()).resolves.toEqual({ kind: 'unauthenticated' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('answers unauthenticated when the retry is still refused', async () => {
    const fetchImpl = stub({ status: 401 }, { status: 200 }, { status: 401 });
    const client = createAuthClient({ fetchImpl });
    await expect(client.me()).resolves.toEqual({ kind: 'unauthenticated' });
  });

  it('shares one refresh between concurrent 401s', async () => {
    const fetchImpl = stub(
      { status: 401 },
      { status: 401 },
      { status: 200 },
      { status: 200, body: { tenants: [TENANT] } },
      { status: 200, body: { userId: 'u1', activeTenant: null } },
    );
    const client = createAuthClient({ fetchImpl });

    const [tenants, me] = await Promise.all([client.tenants(), client.me()]);

    expect(tenants).toEqual({ kind: 'ok', tenants: [TENANT] });
    expect(me.kind).toBe('ok');
    const refreshes = fetchImpl.mock.calls.filter(([url]) => url === '/api/auth/refresh');
    expect(refreshes).toHaveLength(1);
  });

  it('selects a tenant', async () => {
    const fetchImpl = stub({ status: 204 });
    const client = createAuthClient({ fetchImpl });
    await expect(client.selectTenant('t1')).resolves.toEqual({ kind: 'ok' });
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({
      body: JSON.stringify({ tenantId: 't1' }),
    });
  });

  it('rejects a tenant the user cannot use', async () => {
    const client = createAuthClient({ fetchImpl: stub({ status: 403 }) });
    await expect(client.selectTenant('t9')).resolves.toEqual({ kind: 'forbidden' });
  });

  it('logs out and always resolves', async () => {
    const fetchImpl = stub({ status: 204 });
    const client = createAuthClient({ fetchImpl });
    await expect(client.logout()).resolves.toBeUndefined();
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('/api/auth/logout');

    const failing = createAuthClient({
      fetchImpl: vi.fn<FetchLike>(() => Promise.reject(new Error('x'))),
    });
    await expect(failing.logout()).resolves.toBeUndefined();
  });
});
