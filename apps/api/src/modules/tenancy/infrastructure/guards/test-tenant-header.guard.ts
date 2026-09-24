import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { isValidTenantId } from '@sifen/db';
import { ClsService } from 'nestjs-cls';
import { TENANT_ID_CLS_KEY, type TenancyClsStore } from '../tenancy-cls-store.js';

export const TENANT_HEADER = 'x-tenant-id';

/** Opt-in allowlist flag: must be exactly `"true"` for this guard to trust the header. */
export const ENABLE_TEST_TENANT_HEADER_ENV = 'ENABLE_TEST_TENANT_HEADER';

/** Minimal request shape this guard needs, so it never depends on `fastify`'s own types directly. */
interface RequestWithHeaders {
  headers: Record<string, string | string[] | undefined>;
}

/**
 * TEMPORARY tenant resolution: reads the tenant id from a request header
 * with no authentication at all. Valid only until HU-E1-04 replaces it
 * with tenant resolution derived from an authenticated API key.
 *
 * SECURITY: `x-tenant-id` is fully client-controlled and unauthenticated —
 * anyone able to reach the route can set it to any UUID and impersonate
 * that tenant. This guard fails closed: unless `ENABLE_TEST_TENANT_HEADER`
 * is explicitly set to `"true"` (an opt-in allowlist, never a `NODE_ENV`
 * denylist), every request is rejected with 401 regardless of the header,
 * so wiring this guard into a deployment by accident never trusts a
 * spoofed header (spec: db-access, "API guard requires tenant header").
 */
@Injectable()
export class TestTenantHeaderGuard implements CanActivate {
  constructor(private readonly cls: ClsService<TenancyClsStore>) {}

  canActivate(context: ExecutionContext): boolean {
    if (process.env[ENABLE_TEST_TENANT_HEADER_ENV] !== 'true') {
      throw new HttpException(
        `${TENANT_HEADER} header resolution is disabled: set ${ENABLE_TEST_TENANT_HEADER_ENV}=true to enable it`,
        HttpStatus.UNAUTHORIZED,
      );
    }

    const request = context.switchToHttp().getRequest<RequestWithHeaders>();
    const tenantId = request.headers[TENANT_HEADER];

    if (typeof tenantId !== 'string' || tenantId.length === 0) {
      throw new HttpException(`Missing ${TENANT_HEADER} header`, HttpStatus.UNAUTHORIZED);
    }
    if (!isValidTenantId(tenantId)) {
      throw new HttpException(`Invalid ${TENANT_HEADER} header`, HttpStatus.BAD_REQUEST);
    }

    this.cls.set(TENANT_ID_CLS_KEY, tenantId);
    return true;
  }
}
