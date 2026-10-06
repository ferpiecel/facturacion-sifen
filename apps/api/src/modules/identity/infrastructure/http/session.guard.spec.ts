import { ForbiddenException, UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';
import { COOKIE_NAMES } from './auth-cookies.js';
import { REQUIRE_ACTIVE_TENANT_KEY } from './require-active-tenant.decorator.js';
import { SessionGuard } from './session.guard.js';

const RECORD = {
  sessionId: 's-1',
  userId: 'u-1',
  activeTenantId: 't-a',
  mfaVerified: true,
  accessExpiresAt: new Date(),
  refreshExpiresAt: new Date(),
};

function setup(
  opts: {
    record?: typeof RECORD | null;
    memberships?: { tenantId: string; tenantName: string; role: string }[];
    requireTenant?: boolean;
    cookie?: string;
  } = {},
) {
  const sessions = {
    authenticate: vi.fn().mockResolvedValue(opts.record === undefined ? RECORD : opts.record),
    memberships: vi
      .fn()
      .mockResolvedValue(opts.memberships ?? [{ tenantId: 't-a', tenantName: 'A', role: 'admin' }]),
  };
  const reflector = {
    getAllAndOverride: vi.fn().mockReturnValue(opts.requireTenant === true),
  } as unknown as Reflector;
  const request: { headers: Record<string, string>; portalSession?: unknown } = {
    headers:
      opts.cookie === undefined
        ? { cookie: `${COOKIE_NAMES.access}=tok` }
        : { cookie: opts.cookie },
  };
  const context = {
    getHandler: () => ({}),
    getClass: () => ({}),
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
  return {
    guard: new SessionGuard(sessions as never, reflector),
    sessions,
    request,
    context,
    reflector,
  };
}

describe('SessionGuard (verified session, membership re-read on EVERY request)', () => {
  it('resolves the verified session and attaches the user, session and the CURRENT role', async () => {
    const { guard, context, request, sessions } = setup();
    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(sessions.authenticate).toHaveBeenCalledWith('tok');
    expect(request.portalSession).toEqual({
      userId: 'u-1',
      sessionId: 's-1',
      activeTenant: { tenantId: 't-a', role: 'admin' },
    });
  });

  it('re-reads the memberships on each request, so a removed membership takes effect at once', async () => {
    const { guard, context, request, sessions } = setup();
    await guard.canActivate(context);
    sessions.memberships.mockResolvedValue([]);
    await guard.canActivate(context);
    expect(sessions.memberships).toHaveBeenCalledTimes(2);
    expect(request.portalSession).toMatchObject({ activeTenant: null });
  });

  it('reflects a role change immediately', async () => {
    const { guard, context, request, sessions } = setup();
    sessions.memberships.mockResolvedValue([{ tenantId: 't-a', tenantName: 'A', role: 'lector' }]);
    await guard.canActivate(context);
    expect(request.portalSession).toMatchObject({ activeTenant: { role: 'lector' } });
  });

  it.each([[undefined], ['other=1'], [`${COOKIE_NAMES.refresh}=tok`]])(
    'answers 401 without an access cookie (%s)',
    async (cookie) => {
      const { guard, context } = setup({ cookie: cookie ?? '' });
      await expect(guard.canActivate(context)).rejects.toBeInstanceOf(UnauthorizedException);
    },
  );

  it('answers 401 for an unknown, expired or pending session (authenticate returns null)', async () => {
    const { guard, context } = setup({ record: null });
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('answers 403 on a tenant-scoped route when the session has no active tenant or lost the membership', async () => {
    const none = setup({
      requireTenant: true,
      record: { ...RECORD, activeTenantId: null as never },
    });
    await expect(none.guard.canActivate(none.context)).rejects.toBeInstanceOf(ForbiddenException);
    const removed = setup({ requireTenant: true, memberships: [] });
    await expect(removed.guard.canActivate(removed.context)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(REQUIRE_ACTIVE_TENANT_KEY).toBeDefined();
  });
});
