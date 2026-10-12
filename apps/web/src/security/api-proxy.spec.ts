import { describe, expect, it } from 'vitest';

import { apiRewrites } from './api-proxy';

describe('apiRewrites', () => {
  it('proxies /api/auth/* to the API /auth/* so cookies stay on the portal host', () => {
    expect(apiRewrites('http://api.internal:3000')[0]).toEqual({
      source: '/api/auth/:path*',
      destination: 'http://api.internal:3000/auth/:path*',
    });
  });

  it('proxies /api/portal/* to the API /portal/* (documents explorer)', () => {
    expect(apiRewrites('http://api.internal:3000')).toContainEqual({
      source: '/api/portal/:path*',
      destination: 'http://api.internal:3000/portal/:path*',
    });
  });

  it('exposes only the auth and portal routes', () => {
    expect(apiRewrites('http://api.internal:3000').map(({ source }) => source)).toEqual([
      '/api/auth/:path*',
      '/api/portal/:path*',
    ]);
  });

  it('drops a trailing slash from the API URL', () => {
    expect(apiRewrites('http://api.internal:3000/')[0]?.destination).toBe(
      'http://api.internal:3000/auth/:path*',
    );
  });

  it('defaults to a local API', () => {
    expect(apiRewrites(undefined)[0]?.destination).toBe('http://localhost:3000/auth/:path*');
  });

  it('refuses a URL that is not http(s)', () => {
    expect(() => apiRewrites('ftp://x')).toThrow(/API_INTERNAL_URL/);
  });
});
