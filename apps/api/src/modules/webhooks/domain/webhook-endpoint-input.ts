import { isBlockedAddress } from './blocked-address.js';
import { WEBHOOK_EVENT_TYPES } from './webhook-event.js';

export interface InputError {
  readonly field: string;
  readonly message: string;
}

export type Validated<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly errors: readonly InputError[] };

const fail = (field: string, message: string): Validated<never> => ({
  ok: false,
  errors: [{ field, message }],
});

/** Same shape rule as the `webhook_endpoints_url_https` CHECK: lowercase https, non-empty host, no userinfo. */
const URL_SHAPE =
  /^https:\/\/[^/?#:@\s]+(:[0-9]{1,5})?([/?#]\S*)?$|^https:\/\/\[[0-9a-fA-F:.]+\](:[0-9]{1,5})?([/?#]\S*)?$/;

/**
 * Registration-time check: the DB's URL shape plus the SSRF policy for what is decidable without DNS
 * (IP literals, localhost). Names are resolved and re-checked on every delivery attempt.
 */
export function validateEndpointUrl(value: unknown): Validated<string> {
  if (typeof value !== 'string' || value.length === 0) return fail('url', 'url is required');
  if (value.length > 2048) return fail('url', 'url must be at most 2048 characters');
  if (!URL_SHAPE.test(value)) {
    return fail(
      'url',
      'url must be https://<host>[:port][/path] with a lowercase scheme and no credentials',
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return fail('url', 'url is not valid');
  }
  if (parsed.port !== '' && Number(parsed.port) > 65535)
    return fail('url', 'url port is out of range');
  const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const isLiteral = /^[0-9.]+$/.test(host) || host.includes(':');
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    (isLiteral && isBlockedAddress(host))
  ) {
    return fail('url', 'url must not point at a private, loopback or link-local address');
  }
  return { ok: true, value };
}

/** Known event types, no duplicates; an empty list subscribes to every event. */
export function validateEndpointEvents(value: unknown): Validated<readonly string[]> {
  if (!Array.isArray(value)) return fail('events', 'events must be an array');
  const events = value as unknown[];
  const known = WEBHOOK_EVENT_TYPES as readonly string[];
  if (events.some((e) => typeof e !== 'string' || !known.includes(e))) {
    return fail('events', `events must be among: ${known.join(', ')}`);
  }
  if (new Set(events).size !== events.length) return fail('events', 'events must not repeat');
  return { ok: true, value: events as string[] };
}
