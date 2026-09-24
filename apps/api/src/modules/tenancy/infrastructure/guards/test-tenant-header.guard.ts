import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { isValidTenantId } from '@sifen/db';
import { ClsService } from 'nestjs-cls';

export const TENANT_HEADER = 'x-tenant-id';

/** Minimal request shape this guard needs, so it never depends on `fastify`'s own types directly. */
interface RequestWithHeaders {
  headers: Record<string, string | string[] | undefined>;
}

/**
 * TEMPORARY tenant resolution: reads the tenant id from a request header
 * with no authentication at all. Valid only until HU-E1-04 replaces it
 * with tenant resolution derived from an authenticated API key. Refuses to
 * even construct when `NODE_ENV=production`, so this placeholder can never
 * protect a real production route (spec: db-access, "API guard requires
 * tenant header").
 */
@Injectable()
export class TestTenantHeaderGuard implements CanActivate {
  constructor(private readonly cls: ClsService) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error(
        'TestTenantHeaderGuard must never run with NODE_ENV=production: it has no ' +
          'authentication and is a placeholder until HU-E1-04 (API keys).',
      );
    }
  }

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<RequestWithHeaders>();
    const tenantId = request.headers[TENANT_HEADER];

    if (typeof tenantId !== 'string' || tenantId.length === 0) {
      throw new HttpException(`Missing ${TENANT_HEADER} header`, HttpStatus.UNAUTHORIZED);
    }
    if (!isValidTenantId(tenantId)) {
      throw new HttpException(`Invalid ${TENANT_HEADER} header`, HttpStatus.BAD_REQUEST);
    }

    this.cls.set('tenantId', tenantId);
    return true;
  }
}
