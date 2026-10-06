import { normalizeEmail } from '../domain/email.js';
import { hashSessionToken } from '../domain/session-token.js';
import {
  MAX_PASSWORD_LENGTH,
  normalizePassword,
  passwordLength,
} from '../domain/password-policy.js';
import { DUMMY_HASH } from './authenticate-api-key.use-case.js';
import type { ConfirmMfaUseCase, EnrollMfaUseCase, VerifyMfaUseCase } from './mfa.use-cases.js';
import type { AuthEventLog } from './ports/auth-event-log.port.js';
import type { LoginThrottle, ThrottleLimit } from './ports/login-throttle.port.js';
import type { MfaAttemptGuard } from './ports/mfa-attempt-guard.port.js';
import type { MfaStore } from './ports/mfa.ports.js';
import type { SecretVerifier } from './ports/secret-verifier.port.js';
import type { TenantMembership } from './ports/session-store.port.js';
import type { UserCredentialLookup } from './ports/user-credential-lookup.port.js';
import type { IssuedSession, SessionService } from './session.service.js';
import { VerifyPasswordUseCase } from './verify-password.use-case.js';

/**
 * Throttle bounds, counted per ATTEMPT and reserved atomically BEFORE the secret is checked (a check-then-count
 * pair lets a concurrent burst through). NIST SP 800-63B allows up to 100 consecutive failures; we are stricter
 * because the password is checked with Argon2id (an attempt is expensive for us) and every account has a second
 * factor: 5 attempts in 15 minutes lock that account (or, for the second factor, that user) for 15 minutes,
 * which keeps an online guess below ~480 a day per account. The IP limit counts every attempt, successful or
 * not (a success never refunds it), so it is 60 to absorb a shared office address without letting one address
 * spray many accounts. Counters are keyed by a peppered hash, so unknown emails lock too.
 */
export const ACCOUNT_LIMIT: ThrottleLimit = { max: 5, windowSeconds: 900, lockSeconds: 900 };
export const IP_LIMIT: ThrottleLimit = { max: 60, windowSeconds: 900, lockSeconds: 900 };
export const MFA_LIMIT: ThrottleLimit = { max: 5, windowSeconds: 900, lockSeconds: 900 };

/**
 * Consecutive second-factor failures per user before the user is locked until an MFA reset. The 5-per-15-minutes
 * window above still allows ~480 TOTP guesses a day to someone who knows the password (about 0.14 % a day, 40 %
 * a year at ~3 valid codes in 10^6); only a count that time does not reset bounds that. NIST SP 800-63B caps
 * consecutive failures at 100, and a 6-digit code is far weaker than a password, so the cap is 20: a person who
 * mistypes (or a drifting clock) has room, a guesser gets 20 tries (~0.006 %) and then needs an operator.
 */
export const MFA_CONSECUTIVE_FAILURE_CAP = 20;

/**
 * Everything that touches MFA state, built for ONE pending session (from the hash of its token). The SQL behind
 * it resolves the user from that live pending session, so no code path here can name another user's id.
 */
export interface MfaForPending {
  store: Pick<MfaStore, 'find'>;
  enroll: EnrollMfaUseCase;
  confirm: ConfirmMfaUseCase;
  verify: VerifyMfaUseCase;
  guard: MfaAttemptGuard;
}

export interface LoginDeps {
  credentials: UserCredentialLookup;
  verifier: SecretVerifier;
  throttle: LoginThrottle;
  events: AuthEventLog;
  sessions: SessionService;
  mfa: (pendingAccessHash: string) => MfaForPending;
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
    // Reserve first: an attempt that is not granted never reaches the (expensive) real password check.
    const accountAllowed = await this.deps.throttle.reserve(subject, ACCOUNT_LIMIT);
    const ipAllowed =
      input.ip === undefined || (await this.deps.throttle.reserve(`ip:${input.ip}`, IP_LIMIT));
    if (!accountAllowed || !ipAllowed) {
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
      await this.deps.events.record({ event: 'login.password_failed', userId: null, subject });
      return { status: 'invalid' };
    }
    await this.deps.throttle.clear(subject);
    const session = await this.deps.sessions.issue(verified.userId, { mfaVerified: false });
    if (!session) return { status: 'invalid' };
    await this.deps.events.record({ event: 'login.password_ok', userId: verified.userId, subject });
    const mfa = this.deps.mfa(hashSessionToken(session.accessToken));
    const enrolled = (await mfa.store.find(verified.userId))?.confirmedAt != null;
    if (!enrolled) {
      // Recorded server-side only: the HTTP answer must not tell a password holder whether MFA is set up.
      await this.deps.events.record({
        event: 'login.mfa_enrollment_required',
        userId: verified.userId,
        subject,
      });
    }
    return { status: enrolled ? 'mfa_required' : 'mfa_enrollment_required', session };
  }

  /** The user a pending session belongs to, or null for anything that is not one. */
  private async pendingUser(
    pendingToken: string,
  ): Promise<{ userId: string; sessionId: string } | null> {
    const record = await this.deps.sessions.authenticatePending(pendingToken);
    return record && !record.mfaVerified
      ? { userId: record.userId, sessionId: record.sessionId }
      : null;
  }

  async beginEnrollment(input: { pendingToken: string; account: string }) {
    const pending = await this.pendingUser(input.pendingToken);
    if (!pending) return null;
    return this.deps.mfa(hashSessionToken(input.pendingToken)).enroll.execute({
      userId: pending.userId,
      email: input.account,
    });
  }

  /**
   * Reserves a second-factor attempt for the pending user before any code is checked. When the limit is hit
   * the pending session is revoked (the user must log in again) and the attempt is refused unchecked.
   */
  private async reserveMfaAttempt(
    pending: { userId: string; sessionId: string },
    mfa: MfaForPending,
  ): Promise<boolean> {
    const withinWindow = await this.deps.throttle.reserve(`mfa:${pending.userId}`, MFA_LIMIT);
    // A window refusal never reaches the code check, so it does not consume the consecutive cap.
    const withinCap = withinWindow && (await mfa.guard.reserve());
    if (withinCap) return true;
    await this.deps.sessions.logout(pending.sessionId);
    await this.deps.events.record({
      event: withinWindow ? 'login.mfa_cap_reached' : 'login.mfa_locked',
      userId: pending.userId,
      subject: `mfa:${pending.userId}`,
    });
    return false;
  }

  async completeEnrollment(input: {
    pendingToken: string;
    code: string;
  }): Promise<(LoggedIn & { recoveryCodes: string[] }) | null> {
    const pending = await this.pendingUser(input.pendingToken);
    const mfa = this.deps.mfa(hashSessionToken(input.pendingToken));
    if (!pending || !(await this.reserveMfaAttempt(pending, mfa))) return null;
    const tenants = await this.deps.sessions.memberships(pending.userId);
    const confirmed = await mfa.confirm.execute({
      userId: pending.userId,
      code: input.code,
      tenantIds: tenants.map((t) => t.tenantId),
      nowMs: this.now(),
    });
    if (!confirmed) return null;
    await this.deps.throttle.clear(`mfa:${pending.userId}`);
    await mfa.guard.succeeded();
    const done = await this.finish(pending, tenants);
    return done && { ...done, recoveryCodes: confirmed.recoveryCodes };
  }

  async verifyMfa(input: { pendingToken: string; code: string }): Promise<LoggedIn | null> {
    const pending = await this.pendingUser(input.pendingToken);
    const mfa = this.deps.mfa(hashSessionToken(input.pendingToken));
    if (!pending || !(await this.reserveMfaAttempt(pending, mfa))) return null;
    const tenants = await this.deps.sessions.memberships(pending.userId);
    const ok = await mfa.verify.execute({
      userId: pending.userId,
      code: input.code,
      tenantIds: tenants.map((t) => t.tenantId),
      nowMs: this.now(),
    });
    if (!ok) {
      await this.deps.events.record({
        event: 'login.mfa_failed',
        userId: pending.userId,
        subject: `mfa:${pending.userId}`,
      });
      return null;
    }
    await this.deps.throttle.clear(`mfa:${pending.userId}`);
    await mfa.guard.succeeded();
    return this.finish(pending, tenants);
  }

  /**
   * Swaps the pending session for a verified one in ONE atomic step that only succeeds while the pending
   * session is still live (a revoke-all or a reset in between yields no session), then records the success.
   */
  private async finish(
    pending: { userId: string; sessionId: string },
    tenants: TenantMembership[],
  ): Promise<LoggedIn | null> {
    const session = await this.deps.sessions.promote(pending.sessionId);
    if (!session) return null;
    await this.deps.events.record({
      event: 'login.succeeded',
      userId: pending.userId,
      subject: `user:${pending.userId}`,
    });
    return { session, tenants };
  }
}
