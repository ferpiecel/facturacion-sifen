/**
 * Cheap, server-side first line of the route guard: a visitor with no session cookie never gets a portal page,
 * only a redirect to /login. It checks cookie PRESENCE, not validity: the API is the authority (expiry, revocation,
 * active tenant), enforced by the client `SessionGate`. A refresh cookie alone passes so the client can refresh.
 */
const SESSION_COOKIES = ['__Host-sifen_at', '__Host-sifen_rt'];
const PUBLIC = [/^\/login(\/|$)/, /^\/api\/auth(\/|$)/];

export function guardRoute(
  pathname: string,
  cookieNames: ReadonlySet<string>,
): { redirect: string } | null {
  if (PUBLIC.some((pattern) => pattern.test(pathname))) return null;
  if (SESSION_COOKIES.some((name) => cookieNames.has(name))) return null;
  return { redirect: '/login' };
}
