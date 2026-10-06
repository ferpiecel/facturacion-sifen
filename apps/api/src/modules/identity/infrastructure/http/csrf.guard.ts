import { ForbiddenException, Inject, Injectable } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import type { AuthHttpConfig } from './auth-http-config.js';
import { AUTH_HTTP_CONFIG } from './auth-http.tokens.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * CSRF defence for the state-changing `/auth` routes: the request must carry an `Origin` equal to the portal
 * origin. Chosen over a double-submit token because the portal is a same-site BFF whose cookies are
 * `SameSite=Strict`: browsers always send `Origin` on a cross-origin or same-origin POST and a page cannot forge
 * it, so an exact match is enough, needs no token storage or rotation, and also covers login CSRF (no cookie yet).
 * A missing or `null` Origin is refused (a `Referer` alone is not accepted); non-browser clients have no cookie
 * flow here. The check is on the origin string, so `app.example.com.evil.com` and `http://` variants fail.
 */
@Injectable()
export class CsrfGuard implements CanActivate {
  constructor(@Inject(AUTH_HTTP_CONFIG) private readonly config: AuthHttpConfig) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context
      .switchToHttp()
      .getRequest<{ method: string; headers: Record<string, string | string[] | undefined> }>();
    if (SAFE_METHODS.has(request.method.toUpperCase())) return true;
    if (request.headers.origin !== this.config.portalOrigin) {
      throw new ForbiddenException('Invalid request origin');
    }
    return true;
  }
}
