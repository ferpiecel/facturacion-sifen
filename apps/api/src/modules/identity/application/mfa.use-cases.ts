import { SecretDecryptionError } from '../../custody/domain/sealed-secret.js';
import type { PortalRole } from '../domain/portal-role.js';
import {
  findRecoveryCode,
  generateRecoveryCodes,
  hashRecoveryCode,
} from '../domain/recovery-codes.js';
import { generateTotpSecret, base32Encode, otpauthUri, verifyTotp } from '../domain/totp.js';
import type { MfaAuditLog, MfaSecretSealer, MfaStore, SessionRevoker } from './ports/mfa.ports.js';

export class MfaAlreadyEnrolledError extends Error {
  constructor() {
    super('MFA is already enrolled; an owner, admin or the operator must reset it first');
    this.name = 'MfaAlreadyEnrolledError';
  }
}

export class MfaResetForbiddenError extends Error {
  constructor() {
    super("this actor may not reset that user's MFA");
    this.name = 'MfaResetForbiddenError';
  }
}

/** Opens the user's secret, or `null` when the blob does not belong to them; infrastructure errors propagate. */
async function openSecret(
  sealer: MfaSecretSealer,
  sealed: Parameters<MfaSecretSealer['open']>[0],
  userId: string,
) {
  try {
    return await sealer.open(sealed, userId);
  } catch (error) {
    if (error instanceof SecretDecryptionError) return null;
    throw error;
  }
}

/** Starts (or restarts) enrolment: a fresh secret, sealed, pending until a first code confirms it. */
export class EnrollMfaUseCase {
  constructor(
    private readonly store: MfaStore,
    private readonly sealer: MfaSecretSealer,
    private readonly issuer: string,
  ) {}

  async execute(input: { userId: string; email: string }) {
    if ((await this.store.find(input.userId))?.confirmedAt) {
      throw new MfaAlreadyEnrolledError();
    }
    const secret = generateTotpSecret();
    try {
      await this.store.savePending(input.userId, await this.sealer.seal(secret, input.userId));
      return {
        otpauthUri: otpauthUri({ secret, account: input.email, issuer: this.issuer }),
        secretBase32: base32Encode(secret),
      };
    } finally {
      secret.fill(0);
    }
  }
}

/** Confirms enrolment with the first code and issues the recovery codes (shown once, stored hashed). */
export class ConfirmMfaUseCase {
  constructor(
    private readonly store: MfaStore,
    private readonly sealer: MfaSecretSealer,
    private readonly audit: MfaAuditLog,
  ) {}

  async execute(input: {
    userId: string;
    code: string;
    tenantIds: string[];
    nowMs: number;
  }): Promise<{ recoveryCodes: string[] } | null> {
    const record = await this.store.find(input.userId);
    if (!record || record.confirmedAt) return null;
    const secret = await openSecret(this.sealer, record.sealed, input.userId);
    if (!secret) return null;
    try {
      const check = verifyTotp(secret, input.code, input.nowMs);
      if (!check.ok) return null;
      const recoveryCodes = generateRecoveryCodes();
      // Conditional on the secret the code was checked against: a concurrent Enroll that replaced it
      // makes this confirm fail instead of activating a secret nobody proved.
      const hashes = recoveryCodes.map(hashRecoveryCode);
      if (!(await this.store.confirm(input.userId, check.step, hashes, record.sealed))) {
        return null;
      }
      await this.audit.record({
        action: 'mfa.enrolled',
        actor: { type: 'user', id: input.userId },
        targetUserId: input.userId,
        tenantIds: input.tenantIds,
      });
      return { recoveryCodes };
    } finally {
      secret.fill(0);
    }
  }
}

/** Second factor at login: a TOTP (once per step) or a one-time recovery code. */
export class VerifyMfaUseCase {
  constructor(
    private readonly store: MfaStore,
    private readonly sealer: MfaSecretSealer,
    private readonly audit: MfaAuditLog,
  ) {}

  async execute(input: {
    userId: string;
    code: string;
    tenantIds: string[];
    nowMs: number;
  }): Promise<boolean> {
    const record = await this.store.find(input.userId);
    if (!record?.confirmedAt) return false;
    if (!/^\d{6}$/.test(input.code)) {
      return this.useRecoveryCode(input.userId, input.code, record.recoveryHashes, input.tenantIds);
    }
    const secret = await openSecret(this.sealer, record.sealed, input.userId);
    if (!secret) return false;
    try {
      const check = verifyTotp(secret, input.code, input.nowMs, record.lastUsedStep);
      return check.ok && (await this.store.advanceStep(input.userId, check.step));
    } finally {
      secret.fill(0);
    }
  }

  private async useRecoveryCode(
    userId: string,
    code: string,
    hashes: string[],
    tenantIds: string[],
  ): Promise<boolean> {
    const hash = findRecoveryCode(code, hashes);
    if (hash === null || !(await this.store.consumeRecoveryCode(userId, hash))) return false;
    await this.audit.record({
      action: 'mfa.recovery_code_used',
      actor: { type: 'user', id: userId },
      targetUserId: userId,
      tenantIds,
    });
    return true;
  }
}

export type MfaResetActor =
  | { kind: 'operator' }
  /** The tenant the actor is acting in and their role there. */
  | { kind: 'user'; userId: string; tenantId: string; role: PortalRole };

export interface MfaResetTarget {
  userId: string;
  /** EVERY membership of the target: MFA is global, so the decision must see all of them. */
  memberships: { tenantId: string; role: PortalRole }[];
}

/**
 * PROVISIONAL rules (product owner has not answered). MFA is global per user, so a reset affects every
 * tenant the user belongs to. A non-operator may reset only when: the actor is owner or admin of the
 * tenant they act in, the target is a member of that tenant, the target is an owner in NO tenant, and the
 * target is not the actor. Anything else (an owner target, a target outside the tenant) needs the operator.
 *
 * Not atomic across its three steps, ordered so that every partial failure is safe and retryable:
 * (1) audit the authorized reset in each affected tenant (a failure changes nothing); (2) revoke every
 * session (a failure leaves MFA in place); (3) remove the enrolment, after which the user enrols again at
 * next login. Each step is idempotent, so running the reset again completes it; the audit may then hold
 * the event more than once, which records the retry rather than hiding it.
 */
export class ResetMfaUseCase {
  constructor(
    private readonly store: MfaStore,
    private readonly sessions: SessionRevoker,
    private readonly audit: MfaAuditLog,
  ) {}

  async execute(input: { actor: MfaResetActor; target: MfaResetTarget }): Promise<void> {
    const { actor, target } = input;
    const allowed =
      actor.kind === 'operator' ||
      (actor.userId !== target.userId &&
        (actor.role === 'owner' || actor.role === 'admin') &&
        target.memberships.some((m) => m.tenantId === actor.tenantId) &&
        target.memberships.every((m) => m.role !== 'owner'));
    if (!allowed) throw new MfaResetForbiddenError();
    await this.audit.record({
      action: 'mfa.reset',
      actor:
        actor.kind === 'operator'
          ? { type: 'operator', id: 'ops-cli' }
          : { type: 'user', id: actor.userId },
      targetUserId: target.userId,
      tenantIds: target.memberships.map((m) => m.tenantId),
    });
    await this.sessions.revokeAllForUser(target.userId);
    await this.store.remove(target.userId);
  }
}
