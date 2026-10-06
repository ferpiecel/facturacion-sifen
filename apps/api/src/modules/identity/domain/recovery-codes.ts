import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const RECOVERY_CODE_COUNT = 10;

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

/** Ten one-time codes of 16 base32 characters (80 bits) shown once at enrolment: `abcd-efgh-jklm-npqr`. */
export function generateRecoveryCodes(): string[] {
  return Array.from({ length: RECOVERY_CODE_COUNT }, () => {
    const chars = Array.from(randomBytes(16), (byte) => ALPHABET[byte & 31]).join('');
    return chars.match(/.{4}/g)?.join('-') ?? chars;
  });
}

const canonical = (code: string): string => code.toLowerCase().replace(/[\s-]+/g, '');

/**
 * SHA-256 of the canonical code. A fast hash is right here: the codes are 80 random bits, so there is
 * nothing to guess offline, unlike a human-chosen password (which uses Argon2id).
 */
export function hashRecoveryCode(code: string): string {
  return createHash('sha256').update(canonical(code)).digest('hex');
}

/** The stored hash `code` corresponds to, or `null`; compares every hash in constant time. */
export function findRecoveryCode(code: string, storedHashes: readonly string[]): string | null {
  const candidate = Buffer.from(hashRecoveryCode(code), 'hex');
  let found: string | null = null;
  for (const stored of storedHashes) {
    const buffer = Buffer.from(stored, 'hex');
    if (buffer.length === candidate.length && timingSafeEqual(buffer, candidate)) {
      found = stored;
    }
  }
  return found;
}
