import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ClsService } from 'nestjs-cls';
import type { SifenEnvironment } from '../../../../bootstrap/environment.js';
import {
  TENANT_ID_CLS_KEY,
  type TenancyClsStore,
} from '../../../tenancy/infrastructure/tenancy-cls-store.js';
import type { AuthenticateApiKeyUseCase } from '../../application/authenticate-api-key.use-case.js';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator.js';
import { REQUIRED_SCOPES_KEY } from '../decorators/require-scopes.decorator.js';
import { API_KEY_SCOPES_CLS_KEY, type IdentityClsStore } from '../identity-cls-store.js';

const AUTHORIZATION_HEADER = 'authorization';
const BEARER_PREFIX = 'Bearer ';
const GENERIC_UNAUTHORIZED = 'Invalid or missing API key';
const GENERIC_UNAVAILABLE = 'API key authentication is temporarily unavailable';

interface RequestWithHeaders {
  headers: Record<string, string | string[] | undefined>;
}

/**
 * Global authentication guard (backlog HU-E1-04): deny by default. Every
 * failure mode (missing header, malformed header, unknown key, revoked key,
 * wrong secret, environment mismatch) throws the exact same 401 body, so a
 * caller cannot use the response to tell them apart (no oracle).
 *
 * `useCase` is `null` when `DatabaseModule` had no `DATABASE_URL` to
 * connect with; every non-`@Public()` route then fails closed with 503
 * rather than silently accepting requests it cannot authenticate.
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  private readonly logger = new Logger(ApiKeyGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly useCase: AuthenticateApiKeyUseCase | null,
    private readonly cls: ClsService<TenancyClsStore & IdentityClsStore>,
    private readonly environment: SifenEnvironment,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    if (!this.useCase) {
      throw new HttpException(
        'API key authentication is unavailable',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }

    const request = context.switchToHttp().getRequest<RequestWithHeaders>();
    const header = request.headers[AUTHORIZATION_HEADER];
    const token = typeof header === 'string' ? header : undefined;

    if (!token || !token.startsWith(BEARER_PREFIX)) {
      throw new HttpException(GENERIC_UNAUTHORIZED, HttpStatus.UNAUTHORIZED);
    }

    const rawKey = token.slice(BEARER_PREFIX.length);
    let authenticated;
    try {
      authenticated = await this.useCase.execute(rawKey);
    } catch (error) {
      // A DB outage or a corrupt stored hash must never surface as a 500
      // with a leaking stack/message, and must never be treated as "no
      // match" either (that would be a silent-accept-adjacent 401 for a
      // condition that has nothing to do with the caller's credentials).
      this.logger.error(
        'Unexpected error authenticating API key',
        error instanceof Error ? error.stack : error,
      );
      throw new HttpException(GENERIC_UNAVAILABLE, HttpStatus.SERVICE_UNAVAILABLE);
    }

    if (!authenticated) {
      throw new HttpException(GENERIC_UNAUTHORIZED, HttpStatus.UNAUTHORIZED);
    }

    const keyIsLive = authenticated.environment === 'live';
    const appIsProduction = this.environment === 'production';
    if (keyIsLive !== appIsProduction) {
      throw new HttpException(GENERIC_UNAUTHORIZED, HttpStatus.UNAUTHORIZED);
    }

    this.cls.set(TENANT_ID_CLS_KEY, authenticated.tenantId);
    this.cls.set(API_KEY_SCOPES_CLS_KEY, authenticated.scopes);

    const requiredScopes =
      this.reflector.getAllAndOverride<string[] | undefined>(REQUIRED_SCOPES_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? [];
    if (requiredScopes.length > 0) {
      const hasAllScopes = requiredScopes.every((scope) => authenticated.scopes.includes(scope));
      if (!hasAllScopes) {
        throw new HttpException('Missing required scope', HttpStatus.FORBIDDEN);
      }
    }

    return true;
  }
}
