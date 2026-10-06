/** Invalid portal HTTP settings; messages never carry the offending value. */
export class AuthHttpConfigError extends Error {
  override name = 'AuthHttpConfigError';
}

export interface AuthHttpConfig {
  /** The one origin allowed to call the state-changing `/auth` routes (CSRF check). */
  readonly portalOrigin: string;
  /** Reverse proxies in front of the API whose `X-Forwarded-For` entry is trusted; 0 = none (socket address). */
  readonly trustProxyHops: number;
}

const DEVELOPMENT_ORIGIN = 'http://localhost:3000';
const MAX_PROXY_HOPS = 3;

function parseOrigin(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AuthHttpConfigError(
      'PORTAL_ORIGIN must be an origin such as https://app.example.com',
    );
  }
  // An origin is exactly scheme://host[:port]: no path, no userinfo, nothing a browser would not send.
  if (
    (url.protocol !== 'https:' && url.protocol !== 'http:') ||
    url.origin !== raw ||
    url.username !== '' ||
    url.password !== ''
  ) {
    throw new AuthHttpConfigError(
      'PORTAL_ORIGIN must be an origin such as https://app.example.com',
    );
  }
  return url.origin;
}

/**
 * Reads the portal HTTP settings, failing fast at startup. `PORTAL_ORIGIN` is required except in `development`
 * and `test` (an unset or unknown `NODE_ENV` counts as production). `AUTH_TRUST_PROXY_HOPS` is how many reverse
 * proxies add an `X-Forwarded-For` entry we may believe (0 to 3, default 0): the client address is never taken
 * from a raw header, only from the socket or from that many trusted hops.
 */
export function loadAuthHttpConfig(env: NodeJS.ProcessEnv): AuthHttpConfig {
  const lower = env.NODE_ENV === 'development' || env.NODE_ENV === 'test';
  const rawOrigin = env.PORTAL_ORIGIN;
  let portalOrigin: string;
  if (rawOrigin === undefined || rawOrigin === '') {
    if (!lower) throw new AuthHttpConfigError('PORTAL_ORIGIN is required');
    portalOrigin = DEVELOPMENT_ORIGIN;
  } else {
    portalOrigin = parseOrigin(rawOrigin);
  }
  const rawHops = env.AUTH_TRUST_PROXY_HOPS;
  let trustProxyHops = 0;
  if (rawHops !== undefined && rawHops !== '') {
    trustProxyHops = /^\d$/.test(rawHops) ? Number(rawHops) : NaN;
    if (!Number.isInteger(trustProxyHops) || trustProxyHops > MAX_PROXY_HOPS) {
      throw new AuthHttpConfigError('AUTH_TRUST_PROXY_HOPS must be an integer from 0 to 3');
    }
  }
  return { portalOrigin, trustProxyHops };
}
