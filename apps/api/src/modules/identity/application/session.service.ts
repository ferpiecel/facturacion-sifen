import type { SessionConfig } from '../domain/session-config.js';
import { generateSessionToken, hashSessionToken } from '../domain/session-token.js';
import type { SessionRevoker } from './ports/mfa.ports.js';
import type { SessionRecord, SessionStore, TenantMembership } from './ports/session-store.port.js';

export interface IssuedSession {
  sessionId: string;
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: Date;
  refreshExpiresAt: Date;
}

/**
 * Server-side sessions with opaque tokens (HU-E1-07, D2): only the SHA-256 of each token is stored.
 * Access tokens live 5 min and refresh tokens 10 min, sliding while the user keeps refreshing, but never
 * past the absolute cap fixed at login (the store clamps every generation to it). A `null` from
 * `authenticate` or `refresh` is the 401 path: the user logs in again.
 */
export class SessionService implements SessionRevoker {
  constructor(
    private readonly store: SessionStore,
    private readonly config: SessionConfig,
    private readonly now: () => number = Date.now,
  ) {}

  private expiry(seconds: number): Date {
    return new Date(this.now() + seconds * 1000);
  }

  /** Starts a session; `mfaVerified: false` is the pending one that exists only until the second factor. */
  async issue(userId: string, options: { mfaVerified: boolean }): Promise<IssuedSession | null> {
    const accessToken = generateSessionToken();
    const refreshToken = generateSessionToken();
    const accessExpiresAt = this.expiry(this.config.accessTtlSeconds);
    const refreshExpiresAt = this.expiry(this.config.refreshTtlSeconds);
    const sessionId = await this.store.create({
      userId,
      accessHash: hashSessionToken(accessToken),
      refreshHash: hashSessionToken(refreshToken),
      accessExpiresAt,
      refreshExpiresAt,
      absoluteExpiresAt: this.expiry(this.config.absoluteTtlSeconds),
      mfaVerified: options.mfaVerified,
    });
    return sessionId === null
      ? null
      : { sessionId, accessToken, refreshToken, accessExpiresAt, refreshExpiresAt };
  }

  authenticate(accessToken: string): Promise<SessionRecord | null> {
    return accessToken === ''
      ? Promise.resolve(null)
      : this.store.resolve(hashSessionToken(accessToken));
  }

  /** Rotates the pair; reuse of an old refresh token revokes the whole family (see migration 0039). */
  async refresh(refreshToken: string): Promise<IssuedSession | null> {
    if (refreshToken === '') return null;
    const accessToken = generateSessionToken();
    const nextRefresh = generateSessionToken();
    const record = await this.store.rotate(
      hashSessionToken(refreshToken),
      hashSessionToken(accessToken),
      hashSessionToken(nextRefresh),
      this.expiry(this.config.accessTtlSeconds),
      this.expiry(this.config.refreshTtlSeconds),
    );
    return record === null
      ? null
      : {
          sessionId: record.sessionId,
          accessToken,
          refreshToken: nextRefresh,
          accessExpiresAt: record.accessExpiresAt,
          refreshExpiresAt: record.refreshExpiresAt,
        };
  }

  logout(sessionId: string): Promise<void> {
    return this.store.revoke(sessionId);
  }

  /** The SessionRevoker port of the MFA reset: ends every session of the user. */
  async revokeAllForUser(userId: string): Promise<void> {
    await this.store.revokeAllForUser(userId);
  }

  memberships(userId: string): Promise<TenantMembership[]> {
    return this.store.listMemberships(userId);
  }

  selectTenant(sessionId: string, tenantId: string): Promise<boolean> {
    return this.store.setActiveTenant(sessionId, tenantId);
  }
}
