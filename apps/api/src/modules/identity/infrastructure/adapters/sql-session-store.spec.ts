import {
  createPgliteDatabase,
  tenantMemberships,
  tenants,
  userSessions,
  users,
  type DatabaseHandle,
} from '@sifen/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SessionService } from '../../application/session.service.js';
import { SqlSessionStore } from './sql-session-store.js';

const HASH = '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHQ$aGFzaA';
const CONFIG = { accessTtlSeconds: 300, refreshTtlSeconds: 600, absoluteTtlSeconds: 1_200 };

describe('SessionService over SqlSessionStore (HU-E1-07 S4)', () => {
  let handle: DatabaseHandle;
  let service: SessionService;
  let counter = 0;

  beforeAll(async () => {
    handle = createPgliteDatabase();
    await handle.migrate();
    service = new SessionService(new SqlSessionStore(handle.db), CONFIG);
  });

  afterAll(async () => {
    await handle.close();
  });

  async function newUser(): Promise<string> {
    counter += 1;
    const [row] = await handle.db
      .insert(users)
      .values({ email: `u${String(counter)}@example.com`, passwordHash: HASH, displayName: 'U' })
      .returning({ id: users.id });
    return row.id;
  }

  it('issues, authenticates, refreshes and invalidates the old pair', async () => {
    const userId = await newUser();
    const first = await service.issue(userId, { mfaVerified: true });
    expect(await service.authenticate(first?.accessToken ?? '')).toMatchObject({
      userId,
      mfaVerified: true,
    });
    const next = await service.refresh(first?.refreshToken ?? '');
    expect(next).not.toBeNull();
    expect(await service.authenticate(first?.accessToken ?? '')).toBeNull();
    expect(await service.authenticate(next?.accessToken ?? '')).toMatchObject({ userId });
  });

  it('a reused refresh token revokes the whole family and the user must log in again', async () => {
    const userId = await newUser();
    const first = await service.issue(userId, { mfaVerified: true });
    const next = await service.refresh(first?.refreshToken ?? '');
    await expect(service.refresh(first?.refreshToken ?? '')).resolves.toBeNull();
    expect(await service.authenticate(next?.accessToken ?? '')).toBeNull();
    await expect(service.refresh(next?.refreshToken ?? '')).resolves.toBeNull();
  });

  it('a pending session authenticates as not MFA-verified and can never refresh', async () => {
    const userId = await newUser();
    const pending = await service.issue(userId, { mfaVerified: false });
    expect(await service.authenticate(pending?.accessToken ?? '')).toBeNull();
    expect(await service.authenticatePending(pending?.accessToken ?? '')).toMatchObject({
      mfaVerified: false,
    });
    await expect(service.refresh(pending?.refreshToken ?? '')).resolves.toBeNull();
  });

  it('revokeAllForUser ends every session (the SessionRevoker for the MFA reset)', async () => {
    const userId = await newUser();
    const a = await service.issue(userId, { mfaVerified: true });
    const b = await service.issue(userId, { mfaVerified: true });
    await service.revokeAllForUser(userId);
    expect(await service.authenticate(a?.accessToken ?? '')).toBeNull();
    expect(await service.authenticate(b?.accessToken ?? '')).toBeNull();
  });

  it('issues nothing for a disabled user', async () => {
    const userId = await newUser();
    await handle.db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, userId));
    await expect(service.issue(userId, { mfaVerified: true })).resolves.toBeNull();
  });

  it("selects the active tenant among the user's own tenants and keeps it across a refresh", async () => {
    const userId = await newUser();
    const [mine, other] = (
      await handle.db
        .insert(tenants)
        .values([{ name: 'Mine' }, { name: 'Other' }])
        .returning()
    ).map((t) => t.id) as [string, string];
    await handle.db.insert(tenantMemberships).values({ tenantId: mine, userId, role: 'emisor' });
    const issued = await service.issue(userId, { mfaVerified: true });
    const sessionId = issued?.sessionId ?? '';
    expect(await service.memberships(userId)).toEqual([
      { tenantId: mine, tenantName: 'Mine', role: 'emisor' },
    ]);
    expect(await service.selectTenant(sessionId, other)).toBe(false);
    expect(await service.selectTenant(sessionId, mine)).toBe(true);
    const next = await service.refresh(issued?.refreshToken ?? '');
    expect(await service.authenticate(next?.accessToken ?? '')).toMatchObject({
      activeTenantId: mine,
    });
  });

  describe('absolute lifetime cap (decided by the PO)', () => {
    it('refreshes right before the cap with expiries clamped to it', async () => {
      const userId = await newUser();
      const issued = await service.issue(userId, { mfaVerified: true });
      const cap = new Date(Date.now() + 5_000);
      await handle.db
        .update(userSessions)
        .set({ absoluteExpiresAt: cap })
        .where(eq(userSessions.id, issued?.sessionId ?? ''));
      const next = await service.refresh(issued?.refreshToken ?? '');
      expect(next).not.toBeNull();
      expect(next?.accessExpiresAt.getTime()).toBeLessThanOrEqual(cap.getTime());
      expect(next?.refreshExpiresAt.getTime()).toBeLessThanOrEqual(cap.getTime());
    });

    it('returns the 401 path (null) after the cap, however fresh the refresh token is', async () => {
      const userId = await newUser();
      const issued = await service.issue(userId, { mfaVerified: true });
      await handle.db
        .update(userSessions)
        .set({ absoluteExpiresAt: new Date(Date.now() - 1_000) })
        .where(eq(userSessions.id, issued?.sessionId ?? ''));
      await expect(service.refresh(issued?.refreshToken ?? '')).resolves.toBeNull();
      expect(await service.authenticate(issued?.accessToken ?? '')).toBeNull();
    });
  });

  describe('promote (pending to verified)', () => {
    it('issues a verified session, kills the pending one and refuses a second promotion', async () => {
      const userId = await newUser();
      const pending = await service.issue(userId, { mfaVerified: false });
      const verified = await service.promote(pending?.sessionId ?? '');
      expect(await service.authenticatePending(pending?.accessToken ?? '')).toBeNull();
      expect(await service.authenticate(verified?.accessToken ?? '')).toMatchObject({
        userId,
        mfaVerified: true,
      });
      await expect(service.promote(pending?.sessionId ?? '')).resolves.toBeNull();
    });

    it("issues nothing when the user's sessions were revoked in between", async () => {
      const userId = await newUser();
      const pending = await service.issue(userId, { mfaVerified: false });
      await service.revokeAllForUser(userId);
      await expect(service.promote(pending?.sessionId ?? '')).resolves.toBeNull();
    });

    it('lets only one of two concurrent promotions win', async () => {
      const userId = await newUser();
      const pending = await service.issue(userId, { mfaVerified: false });
      const results = await Promise.all([
        service.promote(pending?.sessionId ?? ''),
        service.promote(pending?.sessionId ?? ''),
      ]);
      expect(results.filter(Boolean)).toHaveLength(1);
    });
  });
});
