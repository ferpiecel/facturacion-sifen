import { Module } from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import type { Database } from '@sifen/db';
import { ClsService } from 'nestjs-cls';
import { parseSifenEnvironment, type SifenEnvironment } from '../../bootstrap/environment.js';
import { DATABASE } from '../database/database.module.js';
import type { TenancyClsStore } from '../tenancy/infrastructure/tenancy-cls-store.js';
import { AuthenticateApiKeyUseCase } from './application/authenticate-api-key.use-case.js';
import { Argon2SecretVerifierAdapter } from './infrastructure/adapters/argon2-secret-verifier.adapter.js';
import { SqlApiKeyLookupAdapter } from './infrastructure/adapters/sql-api-key-lookup.adapter.js';
import { ApiKeyGuard } from './infrastructure/guards/api-key.guard.js';
import type { IdentityClsStore } from './infrastructure/identity-cls-store.js';
import { SIFEN_ENVIRONMENT } from './identity.tokens.js';

/**
 * Wires the global `APP_GUARD`: every route is authenticated by
 * {@link ApiKeyGuard} unless marked `@Public()` (backlog HU-E1-04).
 * `AuthenticateApiKeyUseCase` is `null` when `DatabaseModule` has no
 * `DATABASE` (no `DATABASE_URL`), which the guard turns into 503.
 */
@Module({
  providers: [
    {
      provide: AuthenticateApiKeyUseCase,
      useFactory: (db: Database | null): AuthenticateApiKeyUseCase | null =>
        db
          ? new AuthenticateApiKeyUseCase(
              new SqlApiKeyLookupAdapter(db),
              new Argon2SecretVerifierAdapter(),
            )
          : null,
      inject: [DATABASE],
    },
    // useFactory (not useValue): read at module-compile time, not at class
    // decoration time, so tests that set SIFEN_ENVIRONMENT before compiling
    // a fresh testing module observe that value.
    {
      provide: SIFEN_ENVIRONMENT,
      useFactory: () => parseSifenEnvironment(process.env.SIFEN_ENVIRONMENT),
    },
    {
      provide: APP_GUARD,
      useFactory: (
        reflector: Reflector,
        useCase: AuthenticateApiKeyUseCase | null,
        cls: ClsService<TenancyClsStore & IdentityClsStore>,
        environment: SifenEnvironment,
      ) => new ApiKeyGuard(reflector, useCase, cls, environment),
      inject: [Reflector, AuthenticateApiKeyUseCase, ClsService, SIFEN_ENVIRONMENT],
    },
  ],
})
export class IdentityModule {}
