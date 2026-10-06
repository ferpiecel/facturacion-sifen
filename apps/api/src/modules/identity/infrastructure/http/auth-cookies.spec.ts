import { describe, expect, it } from 'vitest';
import { COOKIE_NAMES, buildSetCookie, clearCookie, parseCookies } from './auth-cookies.js';

describe('auth cookies', () => {
  it('uses __Host- names, so the browser enforces Secure, Path=/ and no Domain', () => {
    for (const name of Object.values(COOKIE_NAMES)) expect(name.startsWith('__Host-')).toBe(true);
    expect(new Set(Object.values(COOKIE_NAMES)).size).toBe(3);
  });

  it('sets HttpOnly, Secure, SameSite=Strict, Path=/ and a Max-Age, never a Domain', () => {
    const cookie = buildSetCookie(COOKIE_NAMES.access, 'tok', 300);
    expect(cookie).toBe(
      '__Host-sifen_at=tok; Max-Age=300; Path=/; HttpOnly; Secure; SameSite=Strict',
    );
    expect(cookie).not.toMatch(/Domain/i);
  });

  it('clears a cookie with Max-Age=0 and the same attributes', () => {
    expect(clearCookie(COOKIE_NAMES.refresh)).toBe(
      '__Host-sifen_rt=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Strict',
    );
  });

  it('never emits a Max-Age below 1 for a live cookie and refuses unsafe values', () => {
    expect(buildSetCookie(COOKIE_NAMES.access, 'tok', 0.2)).toContain('Max-Age=1;');
    expect(() => buildSetCookie(COOKIE_NAMES.access, 'a;b', 5)).toThrow();
    expect(() => buildSetCookie(COOKIE_NAMES.access, 'a b', 5)).toThrow();
  });

  it('parses a Cookie header, ignoring malformed pairs and keeping the first of a repeated name', () => {
    expect(parseCookies('a=1; b=2;broken; c=; a=9')).toEqual({ a: '1', b: '2', c: '' });
    expect(parseCookies(undefined)).toEqual({});
  });
});
