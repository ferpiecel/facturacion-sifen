/**
 * Same-origin proxy of the API auth routes (decision for HU-E1-07 S6). The browser calls `/api/auth/*` on the
 * portal origin and Next forwards it to the API:
 * - the API's cookies are `__Host-` (no Domain, host-bound): set through the proxy they belong to the portal
 *   host, so the browser stores and sends them and the portal server can see them;
 * - the API's CSRF check compares `Origin` with `PORTAL_ORIGIN`: a same-origin POST carries exactly that origin;
 * - no CORS on the API, `connect-src 'self'` in the CSP stays as is, and the backend is unchanged.
 * `/api/portal/*` (read-only documents explorer, HU-E12) goes the same way, so the session cookies reach it.
 * Only `/auth/*` and `/portal/*` are exposed; the rest of the API stays server-to-server.
 */
export interface Rewrite {
  source: string;
  destination: string;
}

const DEFAULT_API_URL = 'http://localhost:3000';

export function apiRewrites(apiUrl: string | undefined): Rewrite[] {
  const base = (apiUrl ?? DEFAULT_API_URL).replace(/\/+$/, '');
  if (!/^https?:\/\//.test(base)) {
    throw new Error('API_INTERNAL_URL must be an http(s) URL');
  }
  return [
    { source: '/api/auth/:path*', destination: `${base}/auth/:path*` },
    { source: '/api/portal/:path*', destination: `${base}/portal/:path*` },
  ];
}
