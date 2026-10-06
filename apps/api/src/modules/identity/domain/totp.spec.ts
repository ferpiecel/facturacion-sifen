import { describe, expect, it } from 'vitest';
import { base32Encode, generateTotpSecret, hotp, otpauthUri, totpAt, verifyTotp } from './totp.js';

// RFC 6238 appendix B, SHA-1 secret "12345678901234567890" (the RFC lists 8 digits; we use 6).
const RFC_SECRET = Buffer.from('12345678901234567890', 'ascii');
const RFC_VECTORS: [number, string][] = [
  [59, '287082'],
  [1111111109, '081804'],
  [1111111111, '050471'],
  [1234567890, '005924'],
  [2000000000, '279037'],
  [20000000000, '353130'],
];

describe('TOTP (RFC 6238, HMAC-SHA1, 6 digits, 30 s)', () => {
  it.each(RFC_VECTORS)('matches the RFC test vector at T=%i', (seconds, code) => {
    expect(totpAt(RFC_SECRET, seconds * 1000)).toBe(code);
  });

  it('matches the RFC 4226 HOTP vector for counter 0', () => {
    expect(hotp(RFC_SECRET, 0)).toBe('755224');
  });

  it('generates a 160-bit random secret', () => {
    const [a, b] = [generateTotpSecret(), generateTotpSecret()];
    expect(a).toHaveLength(20);
    expect(a.equals(b)).toBe(false);
  });

  it('encodes base32 per RFC 4648 without padding', () => {
    expect(base32Encode(Buffer.from('12345678901234567890'))).toBe(
      'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
    );
    expect(base32Encode(Buffer.from('f'))).toBe('MY');
  });

  it('builds the otpauth URI an authenticator app scans', () => {
    const uri = otpauthUri({
      secret: RFC_SECRET,
      account: 'ana@example.com',
      issuer: 'Acme Fiscal',
    });
    expect(uri).toBe(
      'otpauth://totp/Acme%20Fiscal:ana%40example.com?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=Acme%20Fiscal&algorithm=SHA1&digits=6&period=30',
    );
  });

  describe('verifyTotp', () => {
    const at = 1111111109_000;
    const step = Math.floor(at / 30_000);

    it('accepts the current code and returns its step', () => {
      expect(verifyTotp(RFC_SECRET, '081804', at)).toEqual({ ok: true, step });
    });

    it('accepts one step of clock drift either way', () => {
      expect(verifyTotp(RFC_SECRET, totpAt(RFC_SECRET, at - 30_000), at)).toEqual({
        ok: true,
        step: step - 1,
      });
      expect(verifyTotp(RFC_SECRET, totpAt(RFC_SECRET, at + 30_000), at)).toEqual({
        ok: true,
        step: step + 1,
      });
    });

    it('rejects two steps of drift', () => {
      expect(verifyTotp(RFC_SECRET, totpAt(RFC_SECRET, at - 60_000), at)).toEqual({ ok: false });
      expect(verifyTotp(RFC_SECRET, totpAt(RFC_SECRET, at + 60_000), at)).toEqual({ ok: false });
    });

    it('rejects a replay: a step at or before the last used one', () => {
      expect(verifyTotp(RFC_SECRET, '081804', at, step)).toEqual({ ok: false });
      expect(verifyTotp(RFC_SECRET, totpAt(RFC_SECRET, at - 30_000), at, step)).toEqual({
        ok: false,
      });
      expect(verifyTotp(RFC_SECRET, totpAt(RFC_SECRET, at + 30_000), at, step)).toEqual({
        ok: true,
        step: step + 1,
      });
    });

    it.each(['', '12345', '1234567', 'abcdef', '08 804', '081804\n'])(
      'rejects the malformed code %j',
      (code) => {
        expect(verifyTotp(RFC_SECRET, code, at)).toEqual({ ok: false });
      },
    );

    it('rejects a wrong code', () => {
      expect(verifyTotp(RFC_SECRET, '000000', at)).toEqual({ ok: false });
    });
  });
});
