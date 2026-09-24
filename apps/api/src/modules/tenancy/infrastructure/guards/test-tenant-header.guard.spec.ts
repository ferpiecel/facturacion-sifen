import { AsyncLocalStorage } from 'node:async_hooks';
import type { ExecutionContext } from '@nestjs/common';
import { HttpException, HttpStatus } from '@nestjs/common';
import { ClsService, type ClsStore } from 'nestjs-cls';
import { afterEach, describe, expect, it } from 'vitest';
import { TENANT_ID_CLS_KEY, type TenancyClsStore } from '../tenancy-cls-store.js';
import { TestTenantHeaderGuard } from './test-tenant-header.guard.js';

const VALID_TENANT_ID = '9c858f84-3e3d-4d4b-9c0a-9c9f0a0a0a0a';

function contextWithHeaders(headers: Record<string, string>): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ headers }),
    }),
  } as unknown as ExecutionContext;
}

function newClsService(): ClsService<TenancyClsStore> {
  return new ClsService(new AsyncLocalStorage<ClsStore>());
}

function expectStatus(fn: () => void, status: HttpStatus): void {
  expect.assertions(1);
  try {
    fn();
  } catch (error) {
    expect((error as HttpException).getStatus()).toBe(status);
  }
}

describe('TestTenantHeaderGuard', () => {
  const originalFlag = process.env.ENABLE_TEST_TENANT_HEADER;

  afterEach(() => {
    if (originalFlag === undefined) {
      delete process.env.ENABLE_TEST_TENANT_HEADER;
    } else {
      process.env.ENABLE_TEST_TENANT_HEADER = originalFlag;
    }
  });

  describe('ENABLE_TEST_TENANT_HEADER not set to "true" (fail closed)', () => {
    it('rejects a request with a valid header with 401 when the flag is unset', () => {
      delete process.env.ENABLE_TEST_TENANT_HEADER;
      const guard = new TestTenantHeaderGuard(newClsService());

      expectStatus(
        () => guard.canActivate(contextWithHeaders({ 'x-tenant-id': VALID_TENANT_ID })),
        HttpStatus.UNAUTHORIZED,
      );
    });

    it('rejects a request with a valid header with 401 when the flag is "false"', () => {
      process.env.ENABLE_TEST_TENANT_HEADER = 'false';
      const guard = new TestTenantHeaderGuard(newClsService());

      expectStatus(
        () => guard.canActivate(contextWithHeaders({ 'x-tenant-id': VALID_TENANT_ID })),
        HttpStatus.UNAUTHORIZED,
      );
    });
  });

  describe('ENABLE_TEST_TENANT_HEADER=true', () => {
    it('rejects a request without the tenant header with 401', () => {
      process.env.ENABLE_TEST_TENANT_HEADER = 'true';
      const guard = new TestTenantHeaderGuard(newClsService());

      expectStatus(() => guard.canActivate(contextWithHeaders({})), HttpStatus.UNAUTHORIZED);
    });

    it('rejects a non-UUID tenant header with 400', () => {
      process.env.ENABLE_TEST_TENANT_HEADER = 'true';
      const guard = new TestTenantHeaderGuard(newClsService());

      expectStatus(
        () => guard.canActivate(contextWithHeaders({ 'x-tenant-id': 'not-a-uuid' })),
        HttpStatus.BAD_REQUEST,
      );
    });

    it('accepts a valid UUID header and sets it on the CLS context', () => {
      process.env.ENABLE_TEST_TENANT_HEADER = 'true';
      const cls = newClsService();
      const guard = new TestTenantHeaderGuard(cls);

      cls.run(() => {
        const activated = guard.canActivate(
          contextWithHeaders({ 'x-tenant-id': VALID_TENANT_ID }),
        );

        expect(activated).toBe(true);
        expect(cls.get(TENANT_ID_CLS_KEY)).toBe(VALID_TENANT_ID);
      });
    });
  });
});
