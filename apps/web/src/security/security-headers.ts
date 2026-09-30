/**
 * Security headers for the portal, applied to every route via `headers()` in
 * next.config.ts.
 *
 * CSP policy:
 * - Fonts are self-hosted by `next/font` at build time, so `font-src 'self'`.
 * - Next injects inline bootstrap scripts, so `script-src` needs
 *   `'unsafe-inline'` until a nonce-based policy is introduced (debt).
 *   `'unsafe-eval'` is allowed in development only (React refresh).
 * - Tailwind emits a static stylesheet, but Next/React may set inline style
 *   attributes, so `style-src` allows `'unsafe-inline'`.
 * - `data:` images cover inlined SVG/icons.
 * - Framing is forbidden (`frame-ancestors 'none'` plus X-Frame-Options).
 */
export type SecurityHeader = { key: string; value: string };

export function buildContentSecurityPolicy(isDev: boolean): string {
  const scriptSrc = ["'self'", "'unsafe-inline'", ...(isDev ? ["'unsafe-eval'"] : [])].join(' ');
  return [
    "default-src 'self'",
    `script-src ${scriptSrc}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

export function securityHeaders(isDev: boolean): SecurityHeader[] {
  return [
    { key: 'Content-Security-Policy', value: buildContentSecurityPolicy(isDev) },
    { key: 'X-Frame-Options', value: 'DENY' },
    { key: 'X-Content-Type-Options', value: 'nosniff' },
    { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
    { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
  ];
}
