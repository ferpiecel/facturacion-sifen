import { describe, expect, it } from 'vitest';
import { parseApiKey } from './api-key.js';

const KEY_ID = 'a'.repeat(24);
const SECRET = 'b'.repeat(32);

describe('parseApiKey', () => {
  it('parses a valid live key', () => {
    expect(parseApiKey(`sk_live_${KEY_ID}_${SECRET}`)).toEqual({
      environment: 'live',
      keyId: KEY_ID,
      secret: SECRET,
    });
  });

  it('parses a valid test key', () => {
    expect(parseApiKey(`sk_test_${KEY_ID}_${SECRET}`)).toEqual({
      environment: 'test',
      keyId: KEY_ID,
      secret: SECRET,
    });
  });

  it('parses a key id at the 64-char upper bound', () => {
    const longKeyId = 'c'.repeat(64);
    expect(parseApiKey(`sk_live_${longKeyId}_${SECRET}`)).toEqual({
      environment: 'live',
      keyId: longKeyId,
      secret: SECRET,
    });
  });

  it('parses a secret longer than 32 chars', () => {
    const longSecret = 'd'.repeat(48);
    expect(parseApiKey(`sk_live_${KEY_ID}_${longSecret}`)).toEqual({
      environment: 'live',
      keyId: KEY_ID,
      secret: longSecret,
    });
  });

  it('parses a secret at the 128-char upper bound', () => {
    const maxSecret = 'e'.repeat(128);
    expect(parseApiKey(`sk_live_${KEY_ID}_${maxSecret}`)).toEqual({
      environment: 'live',
      keyId: KEY_ID,
      secret: maxSecret,
    });
  });

  it.each([
    ['missing prefix', `${KEY_ID}_${SECRET}`],
    ['unknown environment', `sk_staging_${KEY_ID}_${SECRET}`],
    ['key id too short (23 chars)', `sk_live_${'a'.repeat(23)}_${SECRET}`],
    ['key id too long (65 chars)', `sk_live_${'a'.repeat(65)}_${SECRET}`],
    ['key id with invalid chars', `sk_live_${'-'.repeat(24)}_${SECRET}`],
    ['secret too short (31 chars)', `sk_live_${KEY_ID}_${'b'.repeat(31)}`],
    ['secret too long (129 chars)', `sk_live_${KEY_ID}_${'b'.repeat(129)}`],
    ['secret with invalid chars', `sk_live_${KEY_ID}_${'-'.repeat(32)}`],
    ['missing secret segment', `sk_live_${KEY_ID}`],
    ['empty string', ''],
    ['extra trailing underscore segment', `sk_live_${KEY_ID}_${SECRET}_extra`],
  ])('rejects %s', (_label, raw) => {
    expect(parseApiKey(raw)).toBeNull();
  });
});
