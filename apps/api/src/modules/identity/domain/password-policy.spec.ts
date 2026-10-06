import { describe, expect, it } from 'vitest';
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH, validatePassword } from './password-policy.js';

describe('validatePassword (NIST SP 800-63B: length over composition)', () => {
  it('accepts a long passphrase with no digits, symbols or capitals', () => {
    expect(validatePassword('correct horse battery staple')).toEqual([]);
  });

  it('accepts spaces and non-ASCII characters', () => {
    expect(validatePassword('la ñandú corre por el campo')).toEqual([]);
  });

  it('imposes no composition rule on a long enough password', () => {
    expect(validatePassword('qzxvjkwpmtbnrlsd')).toEqual([]);
  });

  it(`rejects fewer than ${String(MIN_PASSWORD_LENGTH)} characters`, () => {
    expect(validatePassword('Xy7!qZ9#kLm')).toEqual(['too_short']);
  });

  it('counts code points, not UTF-16 units', () => {
    const emoji = '🔑'.repeat(MIN_PASSWORD_LENGTH - 1);
    expect(validatePassword(emoji + 'k')).not.toContain('too_short');
    expect(validatePassword(emoji)).toContain('too_short');
  });

  it('normalizes with NFKC before counting', () => {
    // 12 fullwidth letters are 12 characters either way; the decomposed accent counts once.
    expect(validatePassword('é'.repeat(MIN_PASSWORD_LENGTH))).not.toContain('too_short');
    expect(validatePassword('é'.repeat(MIN_PASSWORD_LENGTH - 1))).toContain('too_short');
  });

  it(`rejects more than ${String(MAX_PASSWORD_LENGTH)} characters instead of truncating`, () => {
    expect(validatePassword('a1b2'.repeat(MAX_PASSWORD_LENGTH / 4 + 1))).toContain('too_long');
    expect(validatePassword('a1b2'.repeat(MAX_PASSWORD_LENGTH / 4))).not.toContain('too_long');
  });

  it('rejects common passwords even when padded to the minimum length', () => {
    expect(validatePassword('password1234')).toContain('common');
    expect(validatePassword('Password1234')).toContain('common');
    expect(validatePassword('1234567890123')).toContain('common');
    expect(validatePassword('qwertyuiopasdf')).toContain('common');
  });

  it('rejects a single repeated character and plain sequences', () => {
    expect(validatePassword('aaaaaaaaaaaaaa')).toContain('common');
    expect(validatePassword('abcdefghijklmn')).toContain('common');
  });

  it('rejects service-specific words', () => {
    expect(validatePassword('facturacion-sifen')).toContain('context_specific');
  });

  it('rejects a password built on the account email', () => {
    expect(validatePassword('maria.gomez2026!!', { email: 'maria.gomez@example.com' })).toContain(
      'context_specific',
    );
    expect(validatePassword('maria.gomez2026!!', { email: 'other@example.com' })).toEqual([]);
  });

  it('ignores a very short email local part as context', () => {
    expect(validatePassword('ana is walking home', { email: 'ana@example.com' })).toEqual([]);
  });
});
