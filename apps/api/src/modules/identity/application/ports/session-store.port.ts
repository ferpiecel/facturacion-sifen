export interface SessionRecord {
  sessionId: string;
  userId: string;
  activeTenantId: string | null;
  /** False for the pending session between the password and the second factor. */
  mfaVerified: boolean;
  /** As stored, already clamped to the absolute cap. */
  accessExpiresAt: Date;
  refreshExpiresAt: Date;
}

export interface NewSession {
  userId: string;
  accessHash: string;
  refreshHash: string;
  accessExpiresAt: Date;
  refreshExpiresAt: Date;
  absoluteExpiresAt: Date;
  mfaVerified: boolean;
}

export interface TenantMembership {
  tenantId: string;
  tenantName: string;
  role: string;
}

export type PromotedSession = Omit<NewSession, 'userId' | 'mfaVerified'>;

/** Persistence of sessions; every call is a single atomic operation (see migration 0039). */
export interface SessionStore {
  /** The new session id, or null for an unknown or disabled user. */
  create(input: NewSession): Promise<string | null>;
  resolve(accessHash: string): Promise<SessionRecord | null>;
  /** Compare-and-set rotation; null on an unknown, expired, pending, reused or past-the-cap refresh. */
  rotate(
    oldRefreshHash: string,
    newAccessHash: string,
    newRefreshHash: string,
    accessExpiresAt: Date,
    refreshExpiresAt: Date,
  ): Promise<SessionRecord | null>;
  /**
   * Atomically revokes a still-live PENDING session and creates a verified one from it; the new session id,
   * or null when the pending session is gone, revoked, expired, not pending or already promoted.
   */
  promote(pendingSessionId: string, next: PromotedSession): Promise<string | null>;
  revoke(sessionId: string): Promise<void>;
  revokeAllForUser(userId: string): Promise<number>;
  /** Revokes every generation of the family a refresh token (current or rotated) belongs to; the count. */
  revokeFamily(refreshHash: string): Promise<number>;
  listMemberships(userId: string): Promise<TenantMembership[]>;
  setActiveTenant(sessionId: string, tenantId: string): Promise<boolean>;
}
