import { randomBytes } from 'node:crypto';
import type { ApiKeyEnvironment } from './api-key.js';

// Same charset the parser accepts for both `keyId` and `secret`.
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
// Largest multiple of ALPHABET.length that fits a byte: rejecting bytes at
// or above this ceiling avoids modulo bias (some characters would otherwise
// be very slightly more likely than others).
const REJECTION_CEILING = 256 - (256 % ALPHABET.length);

/** CSPRNG alphanumeric string of exactly `length` characters, unbiased across `ALPHABET`. */
function randomAlphanumeric(length: number): string {
  let result = '';
  while (result.length < length) {
    for (const byte of randomBytes(length - result.length)) {
      if (byte < REJECTION_CEILING) {
        result += ALPHABET[byte % ALPHABET.length];
      }
    }
  }
  return result;
}

export interface GeneratedApiKeySecret {
  /** 32 alphanumerics: within the `api_keys_key_id_format` CHECK (24-64). */
  keyId: string;
  /** 48 alphanumerics: within the parser's accepted secret length (32-128). */
  secret: string;
}

/** Mints a fresh `keyId`/`secret` pair (backlog HU-E1-05) with `node:crypto`'s CSPRNG. */
export function generateApiKeySecret(): GeneratedApiKeySecret {
  return { keyId: randomAlphanumeric(32), secret: randomAlphanumeric(48) };
}

/** Assembles the bearer token the parser in `api-key.ts` expects: `sk_<env>_<keyId>_<secret>`. */
export function formatApiKey(
  environment: ApiKeyEnvironment,
  keyId: string,
  secret: string,
): string {
  return `sk_${environment}_${keyId}_${secret}`;
}
