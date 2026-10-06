/**
 * Browser client of the portal `/auth` routes. It calls the same-origin proxy (`/api/auth/*`, see
 * `security/api-proxy.ts`), so the `__Host-` HttpOnly cookies stay on the portal host and the API's exact-Origin
 * CSRF check sees the portal origin. Tokens never reach JavaScript.
 *
 * A 401 on a session route triggers ONE `/auth/refresh` (shared by concurrent calls) and one retry of the original
 * request; if either fails the answer is `unauthenticated` and the caller sends the user to the login screen.
 */
export interface Tenant {
  tenantId: string;
  tenantName: string;
  role: string;
}
export interface ActiveTenant {
  tenantId: string;
  role: string;
}
export interface PortalSession {
  userId: string;
  activeTenant: ActiveTenant | null;
}

export type Failure = { kind: 'invalid' } | { kind: 'throttled' } | { kind: 'unavailable' };
export type LoginResult = { kind: 'mfa_required' } | Failure;
export type MfaResult =
  { kind: 'ok'; activeTenant: ActiveTenant | null; tenants: Tenant[] } | Failure;
export type MeResult =
  { kind: 'ok'; session: PortalSession } | { kind: 'unauthenticated' } | Failure;
export type TenantsResult =
  { kind: 'ok'; tenants: Tenant[] } | { kind: 'unauthenticated' } | { kind: 'unavailable' };
export type SelectTenantResult =
  { kind: 'ok' } | { kind: 'forbidden' } | { kind: 'unauthenticated' } | { kind: 'unavailable' };

export interface AuthClient {
  login(email: string, password: string): Promise<LoginResult>;
  verifyMfa(code: string): Promise<MfaResult>;
  me(): Promise<MeResult>;
  tenants(): Promise<TenantsResult>;
  selectTenant(tenantId: string): Promise<SelectTenantResult>;
  logout(): Promise<void>;
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

interface Options {
  fetchImpl?: FetchLike;
  baseUrl?: string;
}

function failure(status: number): Failure {
  if (status === 429) return { kind: 'throttled' };
  if (status >= 500) return { kind: 'unavailable' };
  return { kind: 'invalid' };
}

export function createAuthClient({
  fetchImpl = (url, init) => fetch(url, init),
  baseUrl = '/api/auth',
}: Options = {}): AuthClient {
  let refreshing: Promise<boolean> | null = null;

  const send = (path: string, method: 'GET' | 'POST', body?: unknown): Promise<Response> =>
    fetchImpl(`${baseUrl}${path}`, {
      method,
      credentials: 'include',
      ...(body === undefined
        ? {}
        : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    });

  const refresh = (): Promise<boolean> => {
    refreshing ??= send('/refresh', 'POST')
      .then((response) => response.ok)
      .catch(() => false)
      .finally(() => {
        refreshing = null;
      });
    return refreshing;
  };

  /** A session request: on 401 refresh once and retry once. `null` means the session is gone. */
  async function session(path: string, method: 'GET' | 'POST', body?: unknown) {
    const first = await send(path, method, body);
    if (first.status !== 401) return first;
    if (!(await refresh())) return null;
    const second = await send(path, method, body);
    return second.status === 401 ? null : second;
  }

  const guarded = async <T>(run: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      return await run();
    } catch {
      return fallback;
    }
  };

  return {
    login: (email, password) =>
      guarded<LoginResult>(
        async () => {
          const response = await send('/login', 'POST', { email, password });
          return response.ok ? { kind: 'mfa_required' } : failure(response.status);
        },
        { kind: 'unavailable' },
      ),

    verifyMfa: (code) =>
      guarded<MfaResult>(
        async () => {
          const response = await send('/mfa', 'POST', { code });
          if (!response.ok) return failure(response.status);
          const data = (await response.json()) as {
            activeTenant: ActiveTenant | null;
            tenants: Tenant[];
          };
          return { kind: 'ok', activeTenant: data.activeTenant, tenants: data.tenants };
        },
        { kind: 'unavailable' },
      ),

    me: () =>
      guarded<MeResult>(
        async () => {
          const response = await session('/me', 'GET');
          if (!response) return { kind: 'unauthenticated' };
          if (!response.ok) return failure(response.status);
          return { kind: 'ok', session: (await response.json()) as PortalSession };
        },
        { kind: 'unavailable' },
      ),

    tenants: () =>
      guarded<TenantsResult>(
        async () => {
          const response = await session('/tenants', 'GET');
          if (!response) return { kind: 'unauthenticated' };
          if (!response.ok) return { kind: 'unavailable' };
          const data = (await response.json()) as { tenants: Tenant[] };
          return { kind: 'ok', tenants: data.tenants };
        },
        { kind: 'unavailable' },
      ),

    selectTenant: (tenantId) =>
      guarded<SelectTenantResult>(
        async () => {
          const response = await session('/select-tenant', 'POST', { tenantId });
          if (!response) return { kind: 'unauthenticated' };
          if (response.ok) return { kind: 'ok' };
          return response.status === 403 ? { kind: 'forbidden' } : { kind: 'unavailable' };
        },
        { kind: 'unavailable' },
      ),

    logout: async () => {
      await guarded(() => send('/logout', 'POST').then(() => undefined), undefined);
    },
  };
}
