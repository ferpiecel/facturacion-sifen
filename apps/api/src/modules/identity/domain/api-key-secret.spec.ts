import { describe, expect, it } from 'vitest';
import { parseApiKey } from './api-key.js';
import { formatApiKey, generateApiKeySecret } from './api-key-secret.js';

describe('generateApiKeySecret', () => {
  it('generates a keyId and secret matching the parser format', () => {
    const { keyId, secret } = generateApiKeySecret();

    expect(keyId).toMatch(/^[A-Za-z0-9]{32}$/);
    expect(secret).toMatch(/^[A-Za-z0-9]{48}$/);
  });

  it('generates different keyId/secret pairs on every call', () => {
    const first = generateApiKeySecret();
    const second = generateApiKeySecret();

    expect(first.keyId).not.toBe(second.keyId);
    expect(first.secret).not.toBe(second.secret);
  });
});

describe('formatApiKey', () => {
  it('formats a key that parseApiKey accepts back', () => {
    const { keyId, secret } = generateApiKeySecret();

    const formatted = formatApiKey('live', keyId, secret);
    const parsed = parseApiKey(formatted);

    expect(parsed).toEqual({ environment: 'live', keyId, secret });
  });
});
