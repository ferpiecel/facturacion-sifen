import {
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  UnauthorizedException,
  createParamDecorator,
} from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { SessionService } from '../../application/session.service.js';
import { COOKIE_NAMES, parseCookies } from './auth-cookies.js';
import { SESSION_SERVICE } from './auth-http.tokens.js';
import { REQUIRE_ACTIVE_TENANT_KEY } from './require-active-tenant.decorator.js';

/** What a handler knows about the caller; the role is the CURRENT one, read on this request. */
export interface PortalSession {
  userId: string;
  sessionId: string;
  activeTenant: { tenantId: string; role: string } | null;
}

interface RequestWithSession {
  headers: Record<string, string | string[] | undefined>;
  portalSession?: PortalSession;
}

/** The authenticated portal session of the request (set by {@link SessionGuard}). */
export const CurrentSession = createParamDecorator(
  (_data: unknown, context: ExecutionContext): PortalSession | undefined =>
    context.switchToHttp().getRequest<RequestWithSession>().portalSession,
);

/**
 * Resolves the VERIFIED session from the access cookie (a pending, password-only session never passes) and
 * re-reads the user's memberships on EVERY request, so a removed membership or a changed role applies at once
 * instead of at the next refresh. Every failure is the same 401. A selected tenant the user no longer belongs to
 * becomes `activeTenant: null`, and a `@RequireActiveTenant()` route then answers 403.
 */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(
    @Inject(SESSION_SERVICE) private readonly sessions: SessionService | null,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (!this.sessions) {
      throw new HttpException(
        'Portal authentication is unavailable',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    const request = context.switchToHttp().getRequest<RequestWithSession>();
    const token = parseCookies(
      typeof request.headers.cookie === 'string' ? request.headers.cookie : undefined,
    )[COOKIE_NAMES.access];
    const record = token ? await this.sessions.authenticate(token) : null;
    if (!record) throw new UnauthorizedException('Invalid or missing session');

    const memberships = await this.sessions.memberships(record.userId);
    const membership = memberships.find((m) => m.tenantId === record.activeTenantId);
    const activeTenant = membership
      ? { tenantId: membership.tenantId, role: membership.role }
      : null;
    const needsTenant = this.reflector.getAllAndOverride<boolean>(REQUIRE_ACTIVE_TENANT_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (needsTenant && !activeTenant) throw new ForbiddenException('No active tenant');
    request.portalSession = { userId: record.userId, sessionId: record.sessionId, activeTenant };
    return true;
  }
}
