import { AsyncLocalStorage } from 'node:async_hooks';
import type { ExecutionContext } from '@nestjs/common';
import { HttpException, HttpStatus } from '@nestjs/common';
import { ClsService, type ClsStore } from 'nestjs-cls';
import { afterEach, describe, expect, it } from 'vitest';
import { TestTenantHeaderGuard } from './test-tenant-header.guard.js';

function contextWithHeaders(headers: Record<string, string>): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ headers }),
    }),
  } as unknown as ExecutionContext;
}

function newClsService(): ClsService {
  return new ClsService(new AsyncLocalStorage<ClsStore>());
}

describe('TestTenantHeaderGuard', () => {
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  it('throws at construction when NODE_ENV=production', () => {
    process.env.NODE_ENV = 'production';

    expect(() => new TestTenantHeaderGuard(newClsService())).toThrow(/production/);
  });

  it('rejects a request without the tenant header with 401', () => {
    process.env.NODE_ENV = 'test';
    const guard = new TestTenantHeaderGuard(newClsService());

    expect.assertions(1);
    try {
      guard.canActivate(contextWithHeaders({}));
    } catch (error) {
      expect((error as HttpException).getStatus()).toBe(HttpStatus.UNAUTHORIZED);
    }
  });

  it('rejects a non-UUID tenant header with 400', () => {
    process.env.NODE_ENV = 'test';
    const guard = new TestTenantHeaderGuard(newClsService());

    expect.assertions(1);
    try {
      guard.canActivate(contextWithHeaders({ 'x-tenant-id': 'not-a-uuid' }));
    } catch (error) {
      expect((error as HttpException).getStatus()).toBe(HttpStatus.BAD_REQUEST);
    }
  });

  it('accepts a valid UUID header and sets it on the CLS context', () => {
    process.env.NODE_ENV = 'test';
    const cls = newClsService();
    const guard = new TestTenantHeaderGuard(cls);
    const tenantId = '9c858f84-3e3d-4d4b-9c0a-9c9f0a0a0a0a';

    cls.run(() => {
      const activated = guard.canActivate(contextWithHeaders({ 'x-tenant-id': tenantId }));

      expect(activated).toBe(true);
      expect(cls.get('tenantId')).toBe(tenantId);
    });
  });
});
