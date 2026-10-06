/**
 * The three auth cookies. The `__Host-` prefix makes the browser itself refuse the cookie unless it is Secure,
 * has `Path=/` and no `Domain`, so it cannot be set from a sibling subdomain or over plain HTTP. The prefix also
 * forbids a narrower Path, so the refresh cookie CANNOT be scoped to `/auth/refresh` (a `__Secure-` cookie could,
 * but would lose the no-Domain guarantee); it is protected instead by `SameSite=Strict`, HttpOnly, the Origin
 * check on that state-changing route, and the fact that only `/auth/refresh` ever reads it.
 */
export const COOKIE_NAMES = {
  access: '__Host-sifen_at',
  refresh: '__Host-sifen_rt',
  pending: '__Host-sifen_pending',
} as const;

const ATTRIBUTES = 'Path=/; HttpOnly; Secure; SameSite=Strict';
const SAFE_VALUE = /^[A-Za-z0-9._~-]*$/;

/** `Set-Cookie` for a live cookie; the value must already be a safe token (ours are base64url). */
export function buildSetCookie(name: string, value: string, maxAgeSeconds: number): string {
  if (!SAFE_VALUE.test(value)) throw new Error('cookie value contains unsafe characters');
  return `${name}=${value}; Max-Age=${String(Math.max(1, Math.ceil(maxAgeSeconds)))}; ${ATTRIBUTES}`;
}

export function clearCookie(name: string): string {
  return `${name}=; Max-Age=0; ${ATTRIBUTES}`;
}

/** Parses a `Cookie` header; a repeated name keeps its first value and malformed pairs are ignored. */
export function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const pair of (header ?? '').split(';')) {
    const index = pair.indexOf('=');
    if (index <= 0) continue;
    const name = pair.slice(0, index).trim();
    if (name !== '' && !(name in cookies)) cookies[name] = pair.slice(index + 1).trim();
  }
  return cookies;
}
