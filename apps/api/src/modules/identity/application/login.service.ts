import { normalizeEmail } from '../domain/email.js';
import {
  MAX_PASSWORD_LENGTH,
  normalizePassword,
  passwordLength,
} from '../domain/password-policy.js';
import { DUMMY_HASH } from './authenticate-api-key.use-case.js';
import type { ConfirmMfaUseCase, EnrollMfaUseCase, VerifyMfaUseCase } from './mfa.use-cases.js';
import type { AuthEventLog } from './ports/auth-event-log.port.js';
import type { LoginThrottle, ThrottleLimit } from './ports/login-throttle.port.js';
import type { MfaStore } from './ports/mfa.ports.js';
import type { SecretVerifier } from './ports/secret-verifier.port.js';
import type { TenantMembership } from './ports/session-store.port.js';
import type { UserCredentialLookup } from './ports/user-credential-lookup.port.js';
import type { IssuedSession, SessionService } from './session.service.js';
import { VerifyPasswordUseCase } from './verify-password.use-case.js';

/**
 * Throttle bounds. NIST SP 800-63B allows up to 100 consecutive failures; we are stricter because the
 * password is checked with Argon2id (a failed attempt is expensive for us) and every account has a second
 * factor: 5 failures in 15 minutes lock that account (or, for the second factor, that user) for 15 minutes,
 * which keeps an online guess below ~480 a day per account. 20 per IP absorbs a shared office address
 * without letting one address spray many accounts. Counters are keyed by hash, so unknown emails lock too.
 */
export const ACCOUNT_LIMIT: ThrottleLimit = { max: 5, windowSeconds: 900, lockSeconds: 900 };
export const IP_LIMIT: ThrottleLimit = { max: 20, windowSeconds: 900, lockSeconds: 900 };
export const MFA_LIMIT: ThrottleLimit = { max: 5, windowSeconds: 900, lockSeconds: 900 };

export interface LoginDeps {
  credentials: UserCredentialLookup;
  verifier: SecretVerifier;
  throttle: LoginThrottle;
  events: AuthEventLog;
  sessions: SessionService;
  mfaStore: MfaStore;
  enroll: EnrollMfaUseCase;
  confirm: ConfirmMfaUseCase;
  verifyMfa: VerifyMfaUseCase;
  now?: () => number;
}

export type StartResult =
  | { status: 'invalid' }
  | { status: 'mfa_required' | 'mfa_enrollment_required'; session: IssuedSession };

export interface LoggedIn {
  session: IssuedSession;
  /** The tenants to choose the active one from (HU-E1-07 acceptance). */
  tenants: TenantMembership[];
}

/**
 * Password, then MFA (HU-E1-07). Under the provisional product default MFA is mandatory, so the password
 * only opens a PENDING session (`mfaVerified: false`, refresh refused, no tenant selectable); a user without
 * an enrolment must enrol before anything else. The verified session is a brand-new one and the pending one
 * is revoked (no fixation). Every refusal is the same `invalid` / `null`: unknown, wrong, disabled and locked
 * cannot be told apart, and a locked attempt still spends one Argon2 verification.
 */
export class LoginService {
  private readonly verifyPassword: VerifyPasswordUseCase;
  private readonly now: () => number;

  constructor(private readonly deps: LoginDeps) {
    this.verifyPassword = new VerifyPasswordUseCase(deps.credentials, deps.verifier);
    this.now = deps.now ?? Date.now;
  }

  async start(input: { email: string; password: string; ip?: string }): Promise<StartResult> {
    const subject = `account:${normalizeEmail(input.email) ?? input.email.trim().toLowerCase()}`;
    const ipSubject = input.ip === undefined ? null : `ip:${input.ip}`;
    const locked =
      (await this.deps.throttle.isLocked(subject)) ||
      (ipSubject !== null && (await this.deps.throttle.isLocked(ipSubject)));
    if (locked) {
      const oversized = passwordLength(input.password) > MAX_PASSWORD_LENGTH;
      await this.deps.verifier.verify(
        oversized ? '' : normalizePassword(input.password),
        DUMMY_HASH,
      );
      await this.deps.events.record({ event: 'login.locked', userId: null, subject });
      return { status: 'invalid' };
    }
    const verified = await this.verifyPassword.execute(input.email, input.password);
    if (!verified) {
      const accountLocked = await this.deps.throttle.recordFailure(subject, ACCOUNT_LIMIT);
      if (ipSubject !== null) await this.deps.throttle.recordFailure(ipSubject, IP_LIMIT);
      await this.deps.events.record({
        event: 'login.password_failed',
        userId: null,
        subject,
        detail: { locked: accountLocked },
      });
      return { status: 'invalid' };
    }
    await this.deps.throttle.clear(subject);
    const session = await this.deps.sessions.issue(verified.userId, { mfaVerified: false });
    if (!session) return { status: 'invalid' };
    await this.deps.events.record({ event: 'login.password_ok', userId: verified.userId, subject });
    const enrolled = (await this.deps.mfaStore.find(verified.userId))?.confirmedAt != null;
    return { status: enrolled ? 'mfa_required' : 'mfa_enrollment_required', session };
  }

  /** The user a pending session belongs to, or null for anything that is not one. */
  private async pendingUser(
    pendingToken: string,
  ): Promise<{ userId: string; sessionId: string } | null> {
    const record = await this.deps.sessions.authenticate(pendingToken);
    return record && !record.mfaVerified
      ? { userId: record.userId, sessionId: record.sessionId }
      : null;
  }

  async beginEnrollment(input: { pendingToken: string; account: string }) {
    const pending = await this.pendingUser(input.pendingToken);
    if (!pending) return null;
    return this.deps.enroll.execute({ userId: pending.userId, email: input.account });
  }

  async completeEnrollment(input: {
    pendingToken: string;
    code: string;
  }): Promise<(LoggedIn & { recoveryCodes: string[] }) | null> {
    const pending = await this.pendingUser(input.pendingToken);
    if (!pending) return null;
    const tenants = await this.deps.sessions.memberships(pending.userId);
    const confirmed = await this.deps.confirm.execute({
      userId: pending.userId,
      code: input.code,
      tenantIds: tenants.map((t) => t.tenantId),
      nowMs: this.now(),
    });
    if (!confirmed) return null;
    const done = await this.finish(pending, tenants);
    return done && { ...done, recoveryCodes: confirmed.recoveryCodes };
  }

  async verifyMfa(input: { pendingToken: string; code: string }): Promise<LoggedIn | null> {
    const pending = await this.pendingUser(input.pendingToken);
    if (!pending) return null;
    const subject = `mfa:${pending.userId}`;
    if (await this.deps.throttle.isLocked(subject)) return null;
    const tenants = await this.deps.sessions.memberships(pending.userId);
    const ok = await this.deps.verifyMfa.execute({
      userId: pending.userId,
      code: input.code,
      tenantIds: tenants.map((t) => t.tenantId),
      nowMs: this.now(),
    });
    if (!ok) {
      const nowLocked = await this.deps.throttle.recordFailure(subject, MFA_LIMIT);
      await this.deps.events.record({
        event: 'login.mfa_failed',
        userId: pending.userId,
        subject,
        detail: { locked: nowLocked },
      });
      return null;
    }
    await this.deps.throttle.clear(subject);
    return this.finish(pending, tenants);
  }

  /** Swaps the pending session for a fresh verified one and records the success. */
  private async finish(
    pending: { userId: string; sessionId: string },
    tenants: TenantMembership[],
  ): Promise<LoggedIn | null> {
    const session = await this.deps.sessions.issue(pending.userId, { mfaVerified: true });
    if (!session) return null;
    await this.deps.sessions.logout(pending.sessionId);
    await this.deps.events.record({
      event: 'login.succeeded',
      userId: pending.userId,
      subject: `user:${pending.userId}`,
    });
    return { session, tenants };
  }
}
