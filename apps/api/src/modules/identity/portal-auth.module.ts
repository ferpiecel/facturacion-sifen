import { Module } from '@nestjs/common';
import type { Database } from '@sifen/db';
import { EnvelopeCipher } from '../custody/application/envelope-cipher.js';
import { MfaSecretVault } from '../custody/application/mfa-secret-vault.js';
import { CustodyModule } from '../custody/custody.module.js';
import { DATABASE } from '../database/database.module.js';
import {
  ConfirmMfaUseCase,
  EnrollMfaUseCase,
  VerifyMfaUseCase,
} from './application/mfa.use-cases.js';
import { LoginService, MFA_CONSECUTIVE_FAILURE_CAP } from './application/login.service.js';
import { SessionService } from './application/session.service.js';
import { loadAuthPepper } from './domain/auth-config.js';
import { loadSessionConfig } from './domain/session-config.js';
import { Argon2SecretVerifierAdapter } from './infrastructure/adapters/argon2-secret-verifier.adapter.js';
import { SqlAuthEventLog } from './infrastructure/adapters/sql-auth-event-log.js';
import { SqlLoginThrottle } from './infrastructure/adapters/sql-login-throttle.js';
import { SqlMfaAttemptGuard } from './infrastructure/adapters/sql-mfa-attempt-guard.js';
import { SqlMfaRuntimeStore } from './infrastructure/adapters/sql-mfa-runtime-store.js';
import { SqlSessionStore } from './infrastructure/adapters/sql-session-store.js';
import { SqlUserCredentialLookup } from './infrastructure/adapters/sql-user-credential-lookup.js';
import { TenantMfaAuditLog } from './infrastructure/adapters/tenant-mfa-audit-log.js';
import { AuthController } from './infrastructure/http/auth.controller.js';
import { loadAuthHttpConfig } from './infrastructure/http/auth-http-config.js';
import {
  AUTH_HTTP_CONFIG,
  LOGIN_SERVICE,
  SESSION_SERVICE,
} from './infrastructure/http/auth-http.tokens.js';
import { CsrfGuard } from './infrastructure/http/csrf.guard.js';
import { SessionGuard } from './infrastructure/http/session.guard.js';

/** Shown in an authenticator app next to the account; invisible-platform tenants may brand it later (RNF-12). */
const AUTHENTICATOR_ISSUER = 'Facturación electrónica';

/**
 * The portal's `/auth` routes (HU-E1-07 S5). The three configuration loaders run when the module is created, so
 * a missing `AUTH_SUBJECT_PEPPER` or `PORTAL_ORIGIN` or an out-of-range session TTL stops the app at startup, not
 * on the first request. Without a `DATABASE` the app still boots and the routes answer 503.
 */
@Module({
  imports: [CustodyModule],
  controllers: [AuthController],
  providers: [
    { provide: AUTH_HTTP_CONFIG, useFactory: () => loadAuthHttpConfig(process.env) },
    {
      provide: SESSION_SERVICE,
      useFactory: (db: Database | null) => {
        const config = loadSessionConfig(process.env);
        return db ? new SessionService(new SqlSessionStore(db), config) : null;
      },
      inject: [DATABASE],
    },
    {
      provide: LOGIN_SERVICE,
      useFactory: (
        db: Database | null,
        sessions: SessionService | null,
        cipher: EnvelopeCipher,
      ) => {
        const pepper = loadAuthPepper(process.env);
        if (!db || !sessions) return null;
        const vault = new MfaSecretVault(cipher);
        const audit = new TenantMfaAuditLog(db);
        return new LoginService({
          credentials: new SqlUserCredentialLookup(db),
          verifier: new Argon2SecretVerifierAdapter(),
          throttle: new SqlLoginThrottle(db, pepper),
          events: new SqlAuthEventLog(db, pepper),
          sessions,
          // Everything MFA is bound to one pending session: the SQL resolves the user from it, never from a caller.
          mfa: (pendingHash: string) => {
            const store = new SqlMfaRuntimeStore(db, pendingHash);
            return {
              store,
              enroll: new EnrollMfaUseCase(store, vault, AUTHENTICATOR_ISSUER),
              confirm: new ConfirmMfaUseCase(store, vault, audit),
              verify: new VerifyMfaUseCase(store, vault, audit),
              guard: new SqlMfaAttemptGuard(db, MFA_CONSECUTIVE_FAILURE_CAP, pendingHash),
            };
          },
        });
      },
      inject: [DATABASE, SESSION_SERVICE, EnvelopeCipher],
    },
    CsrfGuard,
    SessionGuard,
  ],
})
export class PortalAuthModule {}
