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

  it.each([
    'accessToken',
    'refresh_token',
    'certificatePassword',
    'p12Base64',
    'privateKey',
    'apiKey',
    'api_key',
    'authorization',
    'Cookie',
    'secret',
    'idCsc',
    'secretHash',
  ])('redacts the key variant %s', (key) => {
    expect(redact({ [key]: 'x' })).toEqual({ [key]: REDACTED });
  });

  it('leaves harmless keys untouched', () => {
    expect(redact({ name: 'Acme', amount: 10, ruc: '80000000-1' })).toEqual({
      name: 'Acme',
      amount: 10,
      ruc: '80000000-1',
    });
  });

  it('guards against cycles', () => {
    const node: Record<string, unknown> = { name: 'a' };
    node.self = node;

    expect(redact(node)).toEqual({ name: 'a', self: '[Circular]' });
  });

  it('does not flag a repeated (non-circular) reference as circular', () => {
    const shared = { a: 1 };

    expect(redact({ x: shared, y: shared })).toEqual({ x: { a: 1 }, y: { a: 1 } });
  });

  it('converts binary, Map, Set and BigInt values', () => {
    expect(
      redact({
        buf: Buffer.from('abc'),
        bytes: new Uint8Array([1]),
        map: new Map([['k', 'v']]),
        set: new Set([1, 2]),
        big: 10n,
      }),
    ).toEqual({
      buf: '[Binary]',
      bytes: '[Binary]',
      map: { k: 'v' },
      set: [1, 2],
      big: '10',
    });
  });

  it('redacts secret-shaped string values regardless of key', () => {
    const pem = '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----';

    expect(
      redact({ a: 'sk_live_abcdef123456', b: 'sk_test_abcdef123456', c: pem, d: 'safe' }),
    ).toEqual({ a: REDACTED, b: REDACTED, c: REDACTED, d: 'safe' });
    expect(redact(['sk_live_abcdef123456'])).toEqual([REDACTED]);
  });
});
