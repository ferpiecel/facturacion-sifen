import { FastifyAdapter } from '@nestjs/platform-fastify';

/**
 * Request body cap: 999 items fit within 1 MiB only with short descriptions (up to 2000 characters
 * each); a larger body is answered with 413.
 */
export const HTTP_BODY_LIMIT_BYTES = 1_048_576;

/**
 * `trustProxyHops` is how many reverse proxies' `X-Forwarded-For` entries to believe (`AUTH_TRUST_PROXY_HOPS`,
 * default 0). With 0, `request.ip` is the socket address and the header is ignored, so a client cannot choose
 * the address the login throttle sees.
 */
export function createHttpAdapter(trustProxyHops = 0): FastifyAdapter {
  return new FastifyAdapter({
    bodyLimit: HTTP_BODY_LIMIT_BYTES,
    // Hop 0 is the socket peer; believe the first `trustProxyHops` hops and nothing the client prepended.
    trustProxy:
      trustProxyHops > 0 ? (_address: string, hop: number) => hop < trustProxyHops : false,
  });
}
