import { describe, expect, it } from 'vitest';

import { guardRoute } from './route-guard';

const AT = '__Host-sifen_at';
const RT = '__Host-sifen_rt';

describe('guardRoute (cookie presence only; the API stays the authority)', () => {
  it.each(['/', '/comprobantes', '/seleccionar-empresa', '/comercios'])(
    'sends %s to /login when there is no session cookie',
    (path) => {
      expect(guardRoute(path, new Set())).toEqual({ redirect: '/login' });
    },
  );

  it('lets a user with an access cookie through', () => {
    expect(guardRoute('/', new Set([AT]))).toBeNull();
  });

  it('lets a user with only a refresh cookie through so the client can refresh', () => {
    expect(guardRoute('/comprobantes', new Set([RT]))).toBeNull();
  });

  it('a pending (password-only) cookie is not a session', () => {
    expect(guardRoute('/', new Set(['__Host-sifen_pending']))).toEqual({ redirect: '/login' });
  });

  it.each(['/login', '/login/mfa', '/api/auth/login', '/api/auth/me'])(
    'never guards %s',
    (path) => {
      expect(guardRoute(path, new Set())).toBeNull();
    },
  );

  it('does not treat a look-alike path as public', () => {
    expect(guardRoute('/login-evil', new Set())).toEqual({ redirect: '/login' });
    expect(guardRoute('/apix', new Set())).toEqual({ redirect: '/login' });
  });
});
