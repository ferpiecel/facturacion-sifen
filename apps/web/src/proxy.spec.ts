import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';

import { config, proxy } from './proxy';

function request(path: string, cookie?: string) {
  return new NextRequest(`https://portal.example${path}`, {
    headers: cookie ? { cookie } : {},
  });
}

describe('proxy', () => {
  it('redirects an anonymous visitor to /login', () => {
    const response = proxy(request('/comprobantes'));
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('https://portal.example/login');
  });

  it('passes a request that carries the access cookie', () => {
    const response = proxy(request('/', '__Host-sifen_at=abc'));
    expect(response.headers.get('x-middleware-next')).toBe('1');
  });

  it('skips Next internals and static assets in its matcher', () => {
    expect(config.matcher).toEqual(['/((?!_next/|brand/|favicon.ico).*)']);
  });
});
