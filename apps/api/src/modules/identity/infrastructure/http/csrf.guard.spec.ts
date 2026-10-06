import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { CsrfGuard } from './csrf.guard.js';

const ORIGIN = 'https://app.example.com';
const context = (method: string, headers: Record<string, string> = {}) =>
  ({
    switchToHttp: () => ({ getRequest: () => ({ method, headers }) }),
  }) as unknown as ExecutionContext;

describe('CsrfGuard (Origin check; same-site BFF, SameSite=Strict cookies)', () => {
  const guard = new CsrfGuard({ portalOrigin: ORIGIN, trustProxyHops: 0 });

  it.each(['GET', 'HEAD', 'OPTIONS'])(
    'lets the safe method %s through without an Origin',
    (method) => {
      expect(guard.canActivate(context(method))).toBe(true);
    },
  );

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])(
    'accepts %s only from the portal origin',
    (method) => {
      expect(guard.canActivate(context(method, { origin: ORIGIN }))).toBe(true);
    },
  );

  it.each([
    [{}],
    [{ origin: 'null' }],
    [{ origin: 'https://evil.example.com' }],
    [{ origin: 'https://app.example.com.evil.com' }],
    [{ origin: 'http://app.example.com' }],
    [{ referer: `${ORIGIN}/x` }],
  ])(
    'rejects a state-changing request with headers %j (a Referer alone is not enough)',
    (headers) => {
      expect(() => guard.canActivate(context('POST', headers))).toThrow(ForbiddenException);
    },
  );
});
