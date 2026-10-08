/**
 * Pins the client address that the API's per-IP throttle sees.
 *
 * Next fills `X-Forwarded-For` with the socket address only when the header is ABSENT (base-server `??=`) and its
 * rewrite proxy forwards request headers untouched, so a browser could send its own `X-Forwarded-For` and, with the
 * API's `AUTH_TRUST_PROXY_HOPS=1`, pick its throttle IP. Middleware cannot fix it: it runs after that fill, so it can
 * neither tell the socket address from a spoofed value nor restore it (verified against Next 16.3.6). The pin
 * therefore runs on the Node `request` event, before Next sees the request: it overwrites `X-Forwarded-For` with the
 * socket address and drops `X-Real-IP` and `Forwarded`.
 *
 * Behind a trusted reverse proxy (`PORTAL_TRUSTED_UPSTREAM_PROXY=true`) the headers are kept: that proxy appends the
 * real client address and the API hop count must include it.
 */
interface PinnableRequest {
  headers: Record<string, string | string[] | undefined>;
  socket: { remoteAddress?: string | undefined };
}

export function pinClientAddress(request: PinnableRequest, trustedUpstream: boolean): void {
  if (trustedUpstream) return;
  delete request.headers['x-real-ip'];
  delete request.headers['forwarded'];
  const address = request.socket.remoteAddress;
  if (address) request.headers['x-forwarded-for'] = address;
  else delete request.headers['x-forwarded-for'];
}

const PINNED = Symbol.for('sifen.client-address-pin');

interface Emitter {
  emit: (event: string | symbol, ...args: unknown[]) => boolean;
  [PINNED]?: true;
}

/** Wraps `emit` so every `request` event is pinned first. Idempotent per prototype. */
export function installClientAddressPin(target: object, trustedUpstream: boolean): void {
  const emitter = target as Emitter;
  if (emitter[PINNED]) return;
  const original = emitter.emit;
  emitter.emit = function (this: unknown, event, ...args) {
    if (event === 'request') pinClientAddress(args[0] as PinnableRequest, trustedUpstream);
    return original.call(this, event, ...args);
  };
  emitter[PINNED] = true;
}
