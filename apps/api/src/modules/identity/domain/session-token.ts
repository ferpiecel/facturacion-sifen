import { createHash, randomBytes } from 'node:crypto';

/** 256-bit opaque token (base64url, 43 characters). It carries no data: the server looks it up by hash. */
export function generateSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Lower-case SHA-256 hex digest: all that is stored. The token itself is high-entropy, so no salt or Argon2. */
export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
