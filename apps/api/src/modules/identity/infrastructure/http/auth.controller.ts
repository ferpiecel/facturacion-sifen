import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Inject,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { LoginService } from '../../application/login.service.js';
import type { IssuedSession, SessionService } from '../../application/session.service.js';
import { Public } from '../decorators/public.decorator.js';
import { COOKIE_NAMES, buildSetCookie, clearCookie, parseCookies } from './auth-cookies.js';
import { LOGIN_SERVICE, SESSION_SERVICE } from './auth-http.tokens.js';
import { normalizeClientIp } from './client-ip.js';
import { CsrfGuard } from './csrf.guard.js';
import { CurrentSession, SessionGuard, type PortalSession } from './session.guard.js';

interface HttpRequest {
  headers: Record<string, string | string[] | undefined>;
  ip: string;
}
interface HttpReply {
  header(name: string, value: string | string[]): unknown;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MFA_CODE = /^(\d{6}|[a-zA-Z2-7 -]{16,23})$/;
const ALL_COOKIES = [COOKIE_NAMES.access, COOKIE_NAMES.refresh, COOKIE_NAMES.pending];

const problem = (status: HttpStatus, message: string) =>
  new HttpException({ statusCode: status, message }, status);
const invalid = () => problem(HttpStatus.UNAUTHORIZED, 'Invalid credentials');
const badRequest = () => problem(HttpStatus.BAD_REQUEST, 'Invalid request body');

function asObject(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw badRequest();
  return body as Record<string, unknown>;
}

function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || value === '' || value.length > max) throw badRequest();
  return value;
}

const secondsUntil = (date: Date): number => (date.getTime() - Date.now()) / 1000;

/**
 * The portal's `/auth` routes (HU-E1-07 S5). They are `@Public()` for the API-key guard (a browser has no key)
 * and protected by their own: every POST needs the portal Origin ({@link CsrfGuard}) and the session routes need a
 * verified session ({@link SessionGuard}). There is deliberately NO enrolment route: how a new user activates MFA
 * is a pending product decision, so a user without MFA is refused here and the pending session is revoked.
 */
@Public()
@Controller('auth')
export class AuthController {
  constructor(
    @Inject(LOGIN_SERVICE) private readonly login: LoginService | null,
    @Inject(SESSION_SERVICE) private readonly sessions: SessionService | null,
  ) {}

  private services(): { login: LoginService; sessions: SessionService } {
    if (!this.login || !this.sessions) {
      throw problem(HttpStatus.SERVICE_UNAVAILABLE, 'Portal authentication is unavailable');
    }
    return { login: this.login, sessions: this.sessions };
  }

  private cookies(reply: HttpReply, lines: string[]): void {
    reply.header('set-cookie', lines);
  }

  private sessionCookies(session: IssuedSession): string[] {
    return [
      buildSetCookie(
        COOKIE_NAMES.access,
        session.accessToken,
        secondsUntil(session.accessExpiresAt),
      ),
      buildSetCookie(
        COOKIE_NAMES.refresh,
        session.refreshToken,
        secondsUntil(session.refreshExpiresAt),
      ),
      clearCookie(COOKIE_NAMES.pending),
    ];
  }

  private cookie(request: HttpRequest, name: string): string | undefined {
    const header = request.headers.cookie;
    return parseCookies(typeof header === 'string' ? header : undefined)[name] || undefined;
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @UseGuards(CsrfGuard)
  async start(
    @Body() body: unknown,
    @Req() request: HttpRequest,
    @Res({ passthrough: true }) reply: HttpReply,
  ) {
    const { login, sessions } = this.services();
    const input = asObject(body);
    const result = await login.start({
      email: text(input.email, 320),
      password: text(input.password, 1024),
      ip: normalizeClientIp(request.ip),
    });
    if (result.status === 'invalid') throw invalid();
    if (result.status === 'mfa_enrollment_required') {
      // Indistinguishable from a wrong password (no password oracle): the pending session is revoked, nothing is
      // set, and `LoginService` has already audited `login.mfa_enrollment_required` server-side.
      await sessions.logout(result.session.sessionId);
      throw invalid();
    }
    this.cookies(reply, [
      buildSetCookie(
        COOKIE_NAMES.pending,
        result.session.accessToken,
        secondsUntil(result.session.accessExpiresAt),
      ),
    ]);
    return { status: 'mfa_required' };
  }

  @Post('mfa')
  @HttpCode(HttpStatus.OK)
  @UseGuards(CsrfGuard)
  async verify(
    @Body() body: unknown,
    @Req() request: HttpRequest,
    @Res({ passthrough: true }) reply: HttpReply,
  ) {
    const { login, sessions } = this.services();
    const code = text(asObject(body).code, 32);
    if (!MFA_CODE.test(code)) throw badRequest();
    const pendingToken = this.cookie(request, COOKIE_NAMES.pending);
    const done = pendingToken ? await login.verifyMfa({ pendingToken, code }) : null;
    if (!done) throw invalid();
    this.cookies(reply, this.sessionCookies(done.session));
    // One tenant: nothing to choose. Several: the user picks (POST /auth/select-tenant).
    const only = done.tenants.length === 1 ? done.tenants[0] : undefined;
    if (only && (await sessions.selectTenant(done.session.sessionId, only.tenantId))) {
      return { activeTenant: { tenantId: only.tenantId, role: only.role }, tenants: done.tenants };
    }
    return { activeTenant: null, tenants: done.tenants };
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @UseGuards(CsrfGuard)
  async refresh(@Req() request: HttpRequest, @Res({ passthrough: true }) reply: HttpReply) {
    const { sessions } = this.services();
    const token = this.cookie(request, COOKIE_NAMES.refresh);
    const next = token ? await sessions.refresh(token) : null;
    if (!next) {
      // Idle past the refresh window, past the absolute cap, or a reused token: back to login.
      this.cookies(reply, ALL_COOKIES.map(clearCookie));
      throw problem(HttpStatus.UNAUTHORIZED, 'Session expired');
    }
    this.cookies(reply, this.sessionCookies(next));
    return { status: 'refreshed' };
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(CsrfGuard)
  async logout(
    @Req() request: HttpRequest,
    @Res({ passthrough: true }) reply: HttpReply,
  ): Promise<void> {
    const { sessions } = this.services();
    // Whatever credentials the browser still holds, end them: the access session, a pending (password-only)
    // session and the whole family of the refresh token. All cookies are cleared regardless.
    const access = this.cookie(request, COOKIE_NAMES.access);
    const pending = this.cookie(request, COOKIE_NAMES.pending);
    const refresh = this.cookie(request, COOKIE_NAMES.refresh);
    const record = access ? await sessions.authenticate(access) : null;
    if (record) await sessions.logout(record.sessionId);
    const pendingRecord = pending ? await sessions.authenticatePending(pending) : null;
    if (pendingRecord) await sessions.logout(pendingRecord.sessionId);
    if (refresh) await sessions.logoutByRefreshToken(refresh);
    this.cookies(reply, ALL_COOKIES.map(clearCookie));
  }

  @Get('me')
  @UseGuards(SessionGuard)
  me(@CurrentSession() session: PortalSession) {
    return { userId: session.userId, activeTenant: session.activeTenant };
  }

  @Get('tenants')
  @UseGuards(SessionGuard)
  async tenants(@CurrentSession() session: PortalSession) {
    return { tenants: await this.services().sessions.memberships(session.userId) };
  }

  @Post('select-tenant')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(CsrfGuard, SessionGuard)
  async selectTenant(
    @Body() body: unknown,
    @CurrentSession() session: PortalSession,
  ): Promise<void> {
    const tenantId = text(asObject(body).tenantId, 36);
    if (!UUID.test(tenantId)) throw badRequest();
    if (!(await this.services().sessions.selectTenant(session.sessionId, tenantId))) {
      throw problem(HttpStatus.FORBIDDEN, 'Tenant not available');
    }
  }
}
