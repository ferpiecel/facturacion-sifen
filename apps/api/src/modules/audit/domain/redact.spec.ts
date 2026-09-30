import { describe, expect, it } from 'vitest';
import { REDACTED, redact } from './redact.js';

describe('redact', () => {
  it('masks sensitive keys at the top level', () => {
    expect(redact({ name: 'Acme', secret_hash: 'abc', csc: '123' })).toEqual({
      name: 'Acme',
      secret_hash: REDACTED,
      csc: REDACTED,
    });
  });

  it('masks nested objects and arrays', () => {
    const input = {
      profile: { certificate: { p12: 'bin', label: 'main' } },
      keys: [{ token: 't', id: 1 }, 'plain'],
    };

    expect(redact(input)).toEqual({
      profile: { certificate: REDACTED },
      keys: [{ token: REDACTED, id: 1 }, 'plain'],
    });
  });

  it('matches keys case-insensitively and ignores separators', () => {
    expect(redact({ Password: 'x', apiKeySecret: 'y', 'API-KEY-SECRET': 'z' })).toEqual({
      Password: REDACTED,
      apiKeySecret: REDACTED,
      'API-KEY-SECRET': REDACTED,
    });
  });

  it('accepts a custom key list and does not mutate the input', () => {
    const input = { pin: '1234', password: 'kept' };

    expect(redact(input, ['pin'])).toEqual({ pin: REDACTED, password: 'kept' });
    expect(input).toEqual({ pin: '1234', password: 'kept' });
  });

  it('passes primitives, null and dates through', () => {
    const date = new Date('2026-01-01T00:00:00Z');

    expect(redact(null)).toBeNull();
    expect(redact(5)).toBe(5);
    expect(redact({ at: date })).toEqual({ at: date.toISOString() });
  });
});
