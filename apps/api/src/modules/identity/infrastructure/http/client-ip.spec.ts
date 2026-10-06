import { describe, expect, it } from 'vitest';
import { normalizeClientIp } from './client-ip.js';

describe('normalizeClientIp (throttle subject)', () => {
  it('keeps IPv4 as is and unwraps an IPv4-mapped IPv6 address', () => {
    expect(normalizeClientIp('203.0.113.9')).toBe('203.0.113.9');
    expect(normalizeClientIp('::ffff:203.0.113.9')).toBe('203.0.113.9');
  });

  it('collapses an IPv6 address to its /64, so one host cannot rotate through 2^64 addresses', () => {
    expect(normalizeClientIp('2001:db8:1:2:aaaa:bbbb:cccc:dddd')).toBe('2001:db8:1:2::/64');
    expect(normalizeClientIp('2001:DB8:1:2::1')).toBe('2001:db8:1:2::/64');
    expect(normalizeClientIp('::1')).toBe('0:0:0:0::/64');
  });

  it('returns a fixed bucket for anything that is not an address', () => {
    expect(normalizeClientIp('')).toBe('unknown');
    expect(normalizeClientIp('not-an-ip')).toBe('unknown');
  });
});
