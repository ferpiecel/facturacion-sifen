import { describe, expect, it } from 'vitest';

import { buildContentSecurityPolicy, securityHeaders } from './security-headers';

const headerValue = (key: string) => securityHeaders(false).find((h) => h.key === key)?.value;

describe('buildContentSecurityPolicy', () => {
  it('forbids framing, plugins and foreign bases', () => {
    const csp = buildContentSecurityPolicy(false);
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("form-action 'self'");
  });

  it('does not allow eval in production', () => {
    expect(buildContentSecurityPolicy(false)).not.toContain('unsafe-eval');
  });

  it('allows eval only in development for React refresh', () => {
    expect(buildContentSecurityPolicy(true)).toContain("'unsafe-eval'");
  });
});

describe('securityHeaders', () => {
  it('sets the hardening headers', () => {
    expect(headerValue('X-Frame-Options')).toBe('DENY');
    expect(headerValue('X-Content-Type-Options')).toBe('nosniff');
    expect(headerValue('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
    expect(headerValue('Permissions-Policy')).toBe('camera=(), microphone=(), geolocation=()');
    expect(headerValue('Content-Security-Policy')).toContain("frame-ancestors 'none'");
  });
});
