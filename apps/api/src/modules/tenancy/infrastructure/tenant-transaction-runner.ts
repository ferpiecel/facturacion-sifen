import { Injectable } from '@nestjs/common';
import { withTenantTransaction, type Database, type TenantTx } from '@sifen/db';
import { ClsService } from 'nestjs-cls';
import { MissingTenantContextError } from './missing-tenant-context.error.js';
import { TENANT_ID_CLS_KEY, type TenancyClsStore } from './tenancy-cls-store.js';

/**
 * The single point where `apps/api` request/job handling code reaches
 * `withTenantTransaction`. Resolves the tenant id set by the (temporary)
 * `TestTenantHeaderGuard` from CLS, so no repository or controller ever
 * calls `withTenantTransaction` directly (design.md: single entry point,
 * no `Scope.REQUEST`, ADR-0006).
 */
@Injectable()
export class TenantTransactionRunner {
  constructor(
    private readonly db: Database,
    private readonly cls: ClsService<TenancyClsStore>,
  ) {}

  async run<T>(fn: (tx: TenantTx) => Promise<T>): Promise<T> {
    const tenantId = this.cls.get(TENANT_ID_CLS_KEY);
    if (!tenantId) {
      throw new MissingTenantContextError();
    }
    return withTenantTransaction(this.db, tenantId, fn);
  }
}
