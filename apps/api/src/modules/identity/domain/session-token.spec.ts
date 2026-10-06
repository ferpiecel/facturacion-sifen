import { describe, expect, it } from 'vitest';
import { generateSessionToken, hashSessionToken } from './session-token.js';

describe('session tokens', () => {
  it('are 256-bit opaque base64url values, never repeated', () => {
    const [a, b] = [generateSessionToken(), generateSessionToken()];
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a).not.toBe(b);
  });

  it('are stored as a lower-case SHA-256 hex digest, not reversible to the token', () => {
    const token = generateSessionToken();
    const hash = hashSessionToken(token);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toBe(hashSessionToken(token));
    expect(hash).not.toContain(token);
  });
});
