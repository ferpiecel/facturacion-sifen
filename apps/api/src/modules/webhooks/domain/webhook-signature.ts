import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Webhook signing scheme (ADR-0011). Every delivery carries
 *
 *     Sifen-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>
 *
 * The receiver recomputes the HMAC over the raw request body, compares in constant time
 * and rejects timestamps further than 5 minutes from its clock (anti-replay). During a
 * secret rotation the header carries one `v1` per active secret; any match is valid.
 */
export const SIGNATURE_HEADER = 'Sifen-Signature';
export const SIGNATURE_TOLERANCE_SECONDS = 300;

const V1_HEX = /^[0-9a-f]{64}$/;

function mac(secret: string, timestamp: number, body: string): string {
  return createHmac('sha256', secret)
    .update(`${String(timestamp)}.${body}`, 'utf8')
    .digest('hex');
}

export interface SignWebhookInput {
  /** More than one secret only while a rotation is in its overlap window. */
  readonly secret: string | readonly string[];
  readonly body: string;
  /** Unix seconds. */
  readonly timestamp: number;
}

export function signWebhook({ secret, body, timestamp }: SignWebhookInput): string {
  const secrets = typeof secret === 'string' ? [secret] : secret;
  return [`t=${String(timestamp)}`, ...secrets.map((s) => `v1=${mac(s, timestamp, body)}`)].join(
    ',',
  );
}

export type WebhookVerification =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'malformed' | 'mismatch' | 'stale' };

export interface VerifyWebhookInput {
  readonly secret: string | readonly string[];
  /** The raw request body, byte for byte. */
  readonly body: string;
  readonly header: string;
  /** Receiver clock, unix seconds. */
  readonly now: number;
  readonly toleranceSeconds?: number;
}

/** Constant-time verification helper for integrators (and our own tests). */
export function verifyWebhookSignature(input: VerifyWebhookInput): WebhookVerification {
  let timestamp: number | undefined;
  const signatures: string[] = [];
  for (const part of input.header.split(',')) {
    const [key, value = ''] = part.trim().split('=');
    if (key === 't' && /^[0-9]{1,15}$/.test(value)) {
      timestamp = Number(value);
    } else if (key === 'v1' && V1_HEX.test(value)) {
      signatures.push(value);
    }
  }
  if (timestamp === undefined || signatures.length === 0) {
    return { ok: false, reason: 'malformed' };
  }
  const secrets = typeof input.secret === 'string' ? [input.secret] : input.secret;
  const matched = secrets.some((secret) => {
    const expected = Buffer.from(mac(secret, timestamp, input.body), 'hex');
    return signatures.some((candidate) => timingSafeEqual(expected, Buffer.from(candidate, 'hex')));
  });
  if (!matched) {
    return { ok: false, reason: 'mismatch' };
  }
  const tolerance = input.toleranceSeconds ?? SIGNATURE_TOLERANCE_SECONDS;
  return Math.abs(input.now - timestamp) > tolerance
    ? { ok: false, reason: 'stale' }
    : { ok: true };
}

/** `whsec_` + 256 random bits (base64url). Shown to the integrator once; stored only sealed. */
export function generateWebhookSecret(): string {
  return `whsec_${randomBytes(32).toString('base64url')}`;
}
