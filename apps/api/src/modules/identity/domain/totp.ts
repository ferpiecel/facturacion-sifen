import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** RFC 6238 profile every authenticator app supports by default: HMAC-SHA1, 6 digits, 30 s. */
export const TOTP_DIGITS = 6;
export const TOTP_STEP_SECONDS = 30;
/** Steps of clock drift accepted either side of the current one (+/- 30 s). */
export const TOTP_WINDOW = 1;

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** 160-bit shared secret (RFC 4226 recommends at least 128). */
export function generateTotpSecret(): Buffer {
  return randomBytes(20);
}

/** RFC 4648 base32 without padding, the form authenticator apps take. */
export function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  return bits > 0 ? out + BASE32[(value << (5 - bits)) & 31] : out;
}

/** RFC 4226 HOTP: dynamic truncation of HMAC-SHA1 over the 8-byte big-endian counter. */
export function hotp(secret: Buffer, counter: number): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', secret).update(message).digest();
  const offset = digest[19] & 0x0f;
  const binary = digest.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, '0');
}

const stepOf = (timeMs: number): number => Math.floor(timeMs / (TOTP_STEP_SECONDS * 1000));

export function totpAt(secret: Buffer, timeMs: number): string {
  return hotp(secret, stepOf(timeMs));
}

export type TotpVerification = { ok: true; step: number } | { ok: false };

/**
 * Checks `code` against the steps within {@link TOTP_WINDOW} of `nowMs`. Replay guard: a step at or
 * before `lastUsedStep` is refused, so a code (even a drifted one) works once. Every candidate is
 * compared in constant time and the loop never exits early, so timing does not reveal which step
 * matched or how many digits were right. The caller must still persist `step` atomically.
 */
export function verifyTotp(
  secret: Buffer,
  code: string,
  nowMs: number,
  lastUsedStep: number | null = null,
): TotpVerification {
  if (!/^\d{6}$/.test(code)) {
    return { ok: false };
  }
  const supplied = Buffer.from(code, 'ascii');
  const current = stepOf(nowMs);
  let matched: number | null = null;
  for (let step = current - TOTP_WINDOW; step <= current + TOTP_WINDOW; step += 1) {
    const equal = timingSafeEqual(supplied, Buffer.from(hotp(secret, step), 'ascii'));
    if (equal && (lastUsedStep === null || step > lastUsedStep)) {
      matched = step;
    }
  }
  return matched === null ? { ok: false } : { ok: true, step: matched };
}

export interface OtpauthParams {
  secret: Buffer;
  account: string;
  issuer: string;
}

/** `otpauth://` URI (Key URI Format) to render as a QR code at enrolment. */
export function otpauthUri({ secret, account, issuer }: OtpauthParams): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  return (
    `otpauth://totp/${label}?secret=${base32Encode(secret)}&issuer=${encodeURIComponent(issuer)}` +
    `&algorithm=SHA1&digits=${String(TOTP_DIGITS)}&period=${String(TOTP_STEP_SECONDS)}`
  );
}
