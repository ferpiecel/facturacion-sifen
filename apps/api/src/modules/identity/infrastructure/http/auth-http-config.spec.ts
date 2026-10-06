import { describe, expect, it } from 'vitest';
import { AuthHttpConfigError, loadAuthHttpConfig } from './auth-http-config.js';

describe('loadAuthHttpConfig (portal origin for CSRF, trusted proxy hops)', () => {
  it('requires the portal origin in production and takes it verbatim', () => {
    expect(() => loadAuthHttpConfig({ NODE_ENV: 'production' })).toThrow(AuthHttpConfigError);
    expect(
      loadAuthHttpConfig({ NODE_ENV: 'production', PORTAL_ORIGIN: 'https://app.example.com' }),
    ).toEqual({
      portalOrigin: 'https://app.example.com',
      trustProxyHops: 0,
    });
  });

  it.each([undefined, '', 'staging'])(
    'treats NODE_ENV %j as production (the safe default)',
    (NODE_ENV) => {
      expect(() => loadAuthHttpConfig({ NODE_ENV })).toThrow(AuthHttpConfigError);
    },
  );

  it.each(['development', 'test'])(
    'defaults the portal origin to localhost:3000 in %s',
    (NODE_ENV) => {
      expect(loadAuthHttpConfig({ NODE_ENV }).portalOrigin).toBe('http://localhost:3000');
    },
  );

  it.each([
    'app.example.com',
    'https://app.example.com/',
    'https://app.example.com/path',
    'ftp://x',
    'https://u:p@x.com',
  ])('rejects the portal origin %j (an origin is scheme://host[:port] only)', (PORTAL_ORIGIN) => {
    expect(() => loadAuthHttpConfig({ NODE_ENV: 'production', PORTAL_ORIGIN })).toThrow(
      AuthHttpConfigError,
    );
  });

  it('trusts no proxy by default and only a bounded explicit number of hops', () => {
    const base = { NODE_ENV: 'test' };
    expect(loadAuthHttpConfig(base).trustProxyHops).toBe(0);
    expect(loadAuthHttpConfig({ ...base, AUTH_TRUST_PROXY_HOPS: '2' }).trustProxyHops).toBe(2);
    for (const bad of ['-1', '4', 'x', '1e1', '1.5', ' 1']) {
      expect(() => loadAuthHttpConfig({ ...base, AUTH_TRUST_PROXY_HOPS: bad })).toThrow(
        AuthHttpConfigError,
      );
    }
  });
});
