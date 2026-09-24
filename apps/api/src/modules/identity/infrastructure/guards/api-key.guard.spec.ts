import { AsyncLocalStorage } from 'node:async_hooks';
import { Controller, Get, HttpException, HttpStatus } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ClsService, type ClsStore } from 'nestjs-cls';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  AuthenticateApiKeyUseCase,
  AuthenticatedApiKey,
} from '../../application/authenticate-api-key.use-case.js';
import {
  TENANT_ID_CLS_KEY,
  type TenancyClsStore,
} from '../../../tenancy/infrastructure/tenancy-cls-store.js';
import { Public } from '../decorators/public.decorator.js';
import { RequireScopes } from '../decorators/require-scopes.decorator.js';
import { API_KEY_SCOPES_CLS_KEY, type IdentityClsStore } from '../identity-cls-store.js';
import { ApiKeyGuard } from './api-key.guard.js';

type Store = TenancyClsStore & IdentityClsStore;

@Controller('probe')
class ProbeController {
  @Get()
  protectedRoute() {
    return 'ok';
  }

  @Get('public')
  @Public()
  publicRoute() {
    return 'ok';
  }

  @Get('scoped')
  @RequireScopes('documents:write')
  scopedRoute() {
    return 'ok';
  }
}

@Controller('class-scoped-probe')
@RequireScopes('tenant:read')
class ClassScopedProbeController {
  @Get('merged')
  @RequireScopes('documents:write')
  mergedRoute() {
    return 'ok';
  }

  @Get('class-only')
  classOnlyRoute() {
    return 'ok';
  }
}

type ProbeConstructor = new () => object;

function contextFor(
  handlerName: string,
  headers: Record<string, string>,
  controllerClass: ProbeConstructor = ProbeController,
): ExecutionContext {
  const instance = new controllerClass() as Record<string, () => unknown>;
  // Reflector reads metadata off the function object itself (SetMetadata),
  // and never invokes it through `this` here, so the bare reference is
  // safe despite the lint rule assuming a call site.
  const handler = instance[handlerName];
  return {
    switchToHttp: () => ({ getRequest: () => ({ headers }) }),
    getHandler: () => handler,
    getClass: () => controllerClass,
  } as unknown as ExecutionContext;
}

function makeUseCase(result: AuthenticatedApiKey | null | undefined) {
  const execute = vi.fn<AuthenticateApiKeyUseCase['execute']>();
  if (result !== undefined) {
    execute.mockResolvedValue(result);
  }
  const useCase: AuthenticateApiKeyUseCase = { execute } as unknown as AuthenticateApiKeyUseCase;
  return { useCase, execute };
}

function newCls(): ClsService<Store> {
  return new ClsService(new AsyncLocalStorage<ClsStore>());
}

function getResponseBody(error: unknown): unknown {
  return error instanceof HttpException ? error.getResponse() : error;
}

const AUTHENTICATED: AuthenticatedApiKey = {
  tenantId: 'tenant-1',
  scopes: ['documents:write'],
  environment: 'live',
};

describe('ApiKeyGuard', () => {
  const originalEnv = process.env.SIFEN_ENVIRONMENT;
  afterEach(() => {
    if (originalEnv === undefined) delete process.env.SIFEN_ENVIRONMENT;
    else process.env.SIFEN_ENVIRONMENT = originalEnv;
  });

  it('allows a @Public() route with no header and no db call', async () => {
    const { useCase, execute } = makeUseCase(undefined);
    const guard = new ApiKeyGuard(new Reflector(), useCase, newCls(), 'production');

    const result = await guard.canActivate(contextFor('publicRoute', {}));

    expect(result).toBe(true);
    expect(execute).not.toHaveBeenCalled();
  });

  it('rejects a missing Authorization header with 401', async () => {
    const { useCase } = makeUseCase(undefined);
    const guard = new ApiKeyGuard(new Reflector(), useCase, newCls(), 'production');

    await expect(guard.canActivate(contextFor('protectedRoute', {}))).rejects.toMatchObject({
      status: HttpStatus.UNAUTHORIZED,
    });
  });

  it('rejects a malformed Authorization header (no Bearer prefix) with 401', async () => {
    const { useCase } = makeUseCase(undefined);
    const guard = new ApiKeyGuard(new Reflector(), useCase, newCls(), 'production');

    await expect(
      guard.canActivate(contextFor('protectedRoute', { authorization: 'sk_live_x' })),
    ).rejects.toMatchObject({ status: HttpStatus.UNAUTHORIZED });
  });

  it('accepts a lowercase "bearer" scheme (RFC 7235 is case-insensitive)', async () => {
    const { useCase } = makeUseCase(AUTHENTICATED);
    const cls = newCls();
    const guard = new ApiKeyGuard(new Reflector(), useCase, cls, 'production');

    await expect(
      cls.run(() =>
        guard.canActivate(contextFor('protectedRoute', { authorization: 'bearer sk_live_x' })),
      ),
    ).resolves.toBe(true);
  });

  it('accepts a mixed-case "BeArEr" scheme', async () => {
    const { useCase } = makeUseCase(AUTHENTICATED);
    const cls = newCls();
    const guard = new ApiKeyGuard(new Reflector(), useCase, cls, 'production');

    await expect(
      cls.run(() =>
        guard.canActivate(contextFor('protectedRoute', { authorization: 'BeArEr sk_live_x' })),
      ),
    ).resolves.toBe(true);
  });

  it.each([
    'Bearer  sk_live_x', // two spaces
    'Bearer\tsk_live_x', // tab instead of space
    'Bearer sk_live_x ', // trailing space
    ' Bearer sk_live_x', // leading space
    'Bearer sk_live_x extra', // extra token
    'Bearer',
  ])('rejects a whitespace-malformed header %j with the same 401', async (header) => {
    const { useCase } = makeUseCase(undefined);
    const guard = new ApiKeyGuard(new Reflector(), useCase, newCls(), 'production');

    await expect(
      guard.canActivate(contextFor('protectedRoute', { authorization: header })),
    ).rejects.toMatchObject({ status: HttpStatus.UNAUTHORIZED });
  });

  it('rejects when the use case returns null (unknown/revoked/wrong secret) with 401', async () => {
    const { useCase } = makeUseCase(null);
    const guard = new ApiKeyGuard(new Reflector(), useCase, newCls(), 'production');

    await expect(
      guard.canActivate(contextFor('protectedRoute', { authorization: 'Bearer sk_live_x' })),
    ).rejects.toMatchObject({ status: HttpStatus.UNAUTHORIZED });
  });

  it('missing header and wrong secret produce the identical response body (no oracle)', async () => {
    const { useCase } = makeUseCase(null);
    const guard = new ApiKeyGuard(new Reflector(), useCase, newCls(), 'production');

    const missing = await guard
      .canActivate(contextFor('protectedRoute', {}))
      .catch(getResponseBody);
    const wrongSecret = await guard
      .canActivate(contextFor('protectedRoute', { authorization: 'Bearer sk_live_x' }))
      .catch(getResponseBody);

    expect(missing).toEqual(wrongSecret);
  });

  it('returns 503 when there is no database (use case is null)', async () => {
    const guard = new ApiKeyGuard(new Reflector(), null, newCls(), 'production');

    await expect(
      guard.canActivate(contextFor('protectedRoute', { authorization: 'Bearer sk_live_x' })),
    ).rejects.toMatchObject({ status: HttpStatus.SERVICE_UNAVAILABLE });
  });

  it('a @Public() route never returns 503, even with no database', async () => {
    const guard = new ApiKeyGuard(new Reflector(), null, newCls(), 'production');

    await expect(guard.canActivate(contextFor('publicRoute', {}))).resolves.toBe(true);
  });

  it('rejects a live key when the app runs as test with 401', async () => {
    const { useCase } = makeUseCase(AUTHENTICATED);
    const guard = new ApiKeyGuard(new Reflector(), useCase, newCls(), 'test');

    await expect(
      guard.canActivate(contextFor('protectedRoute', { authorization: 'Bearer sk_live_x' })),
    ).rejects.toMatchObject({ status: HttpStatus.UNAUTHORIZED });
  });

  it('rejects a test key when the app runs as production with 401', async () => {
    const { useCase } = makeUseCase({ ...AUTHENTICATED, environment: 'test' });
    const guard = new ApiKeyGuard(new Reflector(), useCase, newCls(), 'production');

    await expect(
      guard.canActivate(contextFor('protectedRoute', { authorization: 'Bearer sk_test_x' })),
    ).rejects.toMatchObject({ status: HttpStatus.UNAUTHORIZED });
  });

  it('accepts a matching live key on a production app and stores tenant id + scopes in CLS', async () => {
    const { useCase } = makeUseCase(AUTHENTICATED);
    const cls = newCls();
    const guard = new ApiKeyGuard(new Reflector(), useCase, cls, 'production');

    const outcome = await cls.run(async () => {
      const activated = await guard.canActivate(
        contextFor('protectedRoute', { authorization: 'Bearer sk_live_x' }),
      );
      return {
        activated,
        tenantId: cls.get(TENANT_ID_CLS_KEY),
        scopes: cls.get(API_KEY_SCOPES_CLS_KEY),
      };
    });

    expect(outcome).toEqual({ activated: true, tenantId: 'tenant-1', scopes: ['documents:write'] });
  });

  it('allows a scoped route when the key has the required scope', async () => {
    const { useCase } = makeUseCase(AUTHENTICATED);
    const cls = newCls();
    const guard = new ApiKeyGuard(new Reflector(), useCase, cls, 'production');

    await expect(
      cls.run(() =>
        guard.canActivate(contextFor('scopedRoute', { authorization: 'Bearer sk_live_x' })),
      ),
    ).resolves.toBe(true);
  });

  it('returns 503 with a generic body when the use case throws unexpectedly (DB down, corrupt hash)', async () => {
    const { useCase, execute } = makeUseCase(undefined);
    execute.mockRejectedValue(
      new Error('connection terminated unexpectedly: password for user leaked'),
    );
    const guard = new ApiKeyGuard(new Reflector(), useCase, newCls(), 'production');

    const error = await guard
      .canActivate(contextFor('protectedRoute', { authorization: 'Bearer sk_live_x' }))
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({ status: HttpStatus.SERVICE_UNAVAILABLE });
    const body = JSON.stringify(getResponseBody(error));
    expect(body).not.toMatch(/password|leaked|connection terminated/i);
  });

  it('rejects a scoped route with 403 when the key lacks the required scope', async () => {
    const { useCase } = makeUseCase({ ...AUTHENTICATED, scopes: [] });
    const cls = newCls();
    const guard = new ApiKeyGuard(new Reflector(), useCase, cls, 'production');

    await expect(
      cls.run(() =>
        guard.canActivate(contextFor('scopedRoute', { authorization: 'Bearer sk_live_x' })),
      ),
    ).rejects.toMatchObject({ status: HttpStatus.FORBIDDEN });
  });

  it('merges class-level and handler-level @RequireScopes (both are required)', async () => {
    const { useCase } = makeUseCase({
      ...AUTHENTICATED,
      scopes: ['tenant:read', 'documents:write'],
    });
    const cls = newCls();
    const guard = new ApiKeyGuard(new Reflector(), useCase, cls, 'production');

    await expect(
      cls.run(() =>
        guard.canActivate(
          contextFor(
            'mergedRoute',
            { authorization: 'Bearer sk_live_x' },
            ClassScopedProbeController,
          ),
        ),
      ),
    ).resolves.toBe(true);
  });

  it('rejects with 403 when a key has the handler scope but not the class scope', async () => {
    const { useCase } = makeUseCase({ ...AUTHENTICATED, scopes: ['documents:write'] });
    const cls = newCls();
    const guard = new ApiKeyGuard(new Reflector(), useCase, cls, 'production');

    await expect(
      cls.run(() =>
        guard.canActivate(
          contextFor(
            'mergedRoute',
            { authorization: 'Bearer sk_live_x' },
            ClassScopedProbeController,
          ),
        ),
      ),
    ).rejects.toMatchObject({ status: HttpStatus.FORBIDDEN });
  });

  it('enforces a class-level @RequireScopes even when the handler adds none of its own', async () => {
    const { useCase } = makeUseCase({ ...AUTHENTICATED, scopes: [] });
    const cls = newCls();
    const guard = new ApiKeyGuard(new Reflector(), useCase, cls, 'production');

    await expect(
      cls.run(() =>
        guard.canActivate(
          contextFor(
            'classOnlyRoute',
            { authorization: 'Bearer sk_live_x' },
            ClassScopedProbeController,
          ),
        ),
      ),
    ).rejects.toMatchObject({ status: HttpStatus.FORBIDDEN });
  });
});
