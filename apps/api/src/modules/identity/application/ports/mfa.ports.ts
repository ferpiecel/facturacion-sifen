import type { SealedSecret } from '../../../custody/domain/sealed-secret.js';

/** A user's MFA enrolment. `confirmedAt` is null while the first code has not proved the authenticator. */
export interface MfaRecord {
  sealed: SealedSecret;
  confirmedAt: Date | null;
  /** Last TOTP step accepted (replay guard). */
  lastUsedStep: number | null;
  /** SHA-256 of each unused recovery code. */
  recoveryHashes: string[];
}

/** Persistence of MFA state; the two `advance`/`consume` calls must be atomic compare-and-set. */
export interface MfaStore {
  find(userId: string): Promise<MfaRecord | null>;
  /** Creates or replaces an UNCONFIRMED enrolment. */
  savePending(userId: string, sealed: SealedSecret): Promise<void>;
  /** Confirms a pending enrolment; false when there is none or it is already confirmed. */
  confirm(userId: string, step: number, recoveryHashes: string[]): Promise<boolean>;
  /** Records `step` only if it is newer than the stored one; false means a replay or a lost race. */
  advanceStep(userId: string, step: number): Promise<boolean>;
  /** Removes one recovery hash; false when it was not there (already used or a lost race). */
  consumeRecoveryCode(userId: string, hash: string): Promise<boolean>;
  remove(userId: string): Promise<void>;
}

/** Seals the TOTP secret per user (`MfaSecretVault` implements it). */
export interface MfaSecretSealer {
  seal(secret: Buffer, userId: string): Promise<SealedSecret>;
  open(sealed: SealedSecret, userId: string): Promise<Buffer>;
}

/**
 * Ends every session of a user. Sessions arrive in HU-E1-07 S4; until then the wiring supplies a
 * no-op, and a reset already calls it so the guarantee exists from the start.
 */
export interface SessionRevoker {
  revokeAllForUser(userId: string): Promise<void>;
}

export interface MfaAuditEvent {
  action: 'mfa.enrolled' | 'mfa.recovery_code_used' | 'mfa.reset';
  actor: { type: 'user' | 'operator'; id: string };
  targetUserId: string;
}

/** Writes the audit trail of MFA events (never codes or secrets). */
export interface MfaAuditLog {
  record(event: MfaAuditEvent): Promise<void>;
}
