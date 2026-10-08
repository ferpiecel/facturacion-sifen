import {
  auditLog,
  createPgliteDatabase,
  tenantMemberships,
  tenants,
  userMfa,
  users,
  type DatabaseHandle,
} from '@sifen/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SealedSecret } from '../../../custody/domain/sealed-secret.js';
import { SessionService } from '../../application/session.service.js';
import { hashSessionToken } from '../../domain/session-token.js';
import { SqlMfaRuntimeStore } from './sql-mfa-runtime-store.js';
import { SqlSessionStore } from './sql-session-store.js';
import { TenantMfaAuditLog } from './tenant-mfa-audit-log.js';

const SEALED: SealedSecret = {
  v: 1,
  keyId: 'k',
  wrappedKey: 'AA==',
  nonce: 'AA==',
  tag: 'AA==',
  ciphertext: 'AA==',
};
const HASH = '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHQ$aGFzaA';
const hex = (c: string) => c.repeat(64);

describe('SqlMfaRuntimeStore and TenantMfaAuditLog (HU-E1-07 login runtime)', () => {
  let handle: DatabaseHandle;
  let store: SqlMfaRuntimeStore;
  let userId: string;
  let pendingHash: string;

  beforeAll(async () => {
    handle = createPgliteDatabase();
    await handle.migrate();
    const [row] = await handle.db
      .insert(users)
      .values({ email: 'r@example.com', passwordHash: HASH, displayName: 'R' })
      .returning({ id: users.id });
    userId = row.id;
    await handle.db.insert(userMfa).values({ userId, sealed: SEALED });
    await handle.db
      .update(userMfa)
      .set({ confirmedAt: new Date(), lastUsedStep: 10, recoveryHashes: [hex('a'), hex('b')] });
    const pending = await new SessionService(new SqlSessionStore(handle.db), {
      accessTtlSeconds: 300,
      refreshTtlSeconds: 600,
      absoluteTtlSeconds: 1200,
    }).issue(userId, { mfaVerified: false });
    pendingHash = hashSessionToken(pending?.accessToken ?? '');
    store = new SqlMfaRuntimeStore(handle.db, pendingHash);
  });

  afterAll(async () => {
    await handle.close();
  });

  it('finds the enrolment, and null for a user without one', async () => {
    expect(await store.find()).toMatchObject({
      sealed: SEALED,
      lastUsedStep: 10,
      recoveryHashes: [hex('a'), hex('b')],
    });
    expect((await store.find())?.confirmedAt).toBeInstanceOf(Date);
    expect(await new SqlMfaRuntimeStore(handle.db, hashSessionToken('nope')).find()).toBeNull();
    // The userId argument is ignored: the store only ever reads the pending session's own user.
    expect(await store.find()).toMatchObject({
      lastUsedStep: 10,
    });
  });

  it('advances the step forward only and consumes a recovery code once', async () => {
    expect(await store.advanceStep(userId, 11)).toBe(true);
    expect(await store.advanceStep(userId, 11)).toBe(false);
    expect(await store.consumeRecoveryCode(userId, hex('a'))).toBe(true);
    expect(await store.consumeRecoveryCode(userId, hex('a'))).toBe(false);
  });

  it('a store bound to no live pending session cannot spend a step or a code', async () => {
    const stranger = new SqlMfaRuntimeStore(handle.db, hashSessionToken('nope'));
    expect(await stranger.advanceStep(userId, 999)).toBe(false);
    expect(await stranger.consumeRecoveryCode(userId, hex('b'))).toBe(false);
    expect(pendingHash).toHaveLength(64);
  });

  it('does not support removing an enrolment at runtime (a reset is an operator action)', async () => {
    await expect(store.remove(userId)).rejects.toThrow(/not available/);
  });

  describe('enrolment through the pending session', () => {
    let enrolPending: string;
    let enrolUser: string;
    let enrolStore: SqlMfaRuntimeStore;
    const sealedB: SealedSecret = { ...SEALED, ciphertext: 'BB==' };

    beforeAll(async () => {
      const [row] = await handle.db
        .insert(users)
        .values({ email: 'e@example.com', passwordHash: HASH, displayName: 'E' })
        .returning({ id: users.id });
      enrolUser = row.id;
      const pending = await new SessionService(new SqlSessionStore(handle.db), {
        accessTtlSeconds: 300,
        refreshTtlSeconds: 600,
        absoluteTtlSeconds: 1200,
      }).issue(enrolUser, { mfaVerified: false });
      enrolPending = hashSessionToken(pending?.accessToken ?? '');
      enrolStore = new SqlMfaRuntimeStore(handle.db, enrolPending);
    });

    it('reads the account email of the pending user, and null for a stranger', async () => {
      expect(await enrolStore.account()).toBe('e@example.com');
      expect(
        await new SqlMfaRuntimeStore(handle.db, hashSessionToken('nope')).account(),
      ).toBeNull();
    });

    it('saves a pending secret, replaces it, then confirms only the secret the code was checked against', async () => {
      await enrolStore.savePending(enrolUser, SEALED);
      await enrolStore.savePending(enrolUser, sealedB);
      expect((await enrolStore.find())?.sealed).toEqual(sealedB);
      expect(await enrolStore.confirm(enrolUser, 5, [hex('c')], SEALED)).toBe(false);
      expect(await enrolStore.confirm(enrolUser, 5, [hex('c')], sealedB)).toBe(true);
      expect(await enrolStore.find()).toMatchObject({
        lastUsedStep: 5,
        recoveryHashes: [hex('c')],
      });
      expect((await enrolStore.find())?.confirmedAt).toBeInstanceOf(Date);
    });

    it('refuses to replace or re-confirm a confirmed enrolment', async () => {
      await expect(enrolStore.savePending(enrolUser, SEALED)).rejects.toThrow(/already confirmed/);
      expect(await enrolStore.confirm(enrolUser, 6, [hex('d')], sealedB)).toBe(false);
      expect((await enrolStore.find())?.sealed).toEqual(sealedB);
    });

    it('a store bound to no live pending session writes nothing', async () => {
      const stranger = new SqlMfaRuntimeStore(handle.db, hashSessionToken('nope'));
      await expect(stranger.savePending(enrolUser, SEALED)).rejects.toThrow();
      expect(await stranger.confirm(enrolUser, 1, [], sealedB)).toBe(false);
    });
  });

  it('writes an MFA audit event into each listed tenant as the user actor', async () => {
    const [a, b] = (
      await handle.db
        .insert(tenants)
        .values([{ name: 'A' }, { name: 'B' }])
        .returning()
    ).map((t) => t.id) as [string, string];
    await handle.db.insert(tenantMemberships).values([
      { tenantId: a, userId, role: 'admin' },
      { tenantId: b, userId, role: 'lector' },
    ]);
    await new TenantMfaAuditLog(handle.db).record({
      action: 'mfa.recovery_code_used',
      actor: { type: 'user', id: userId },
      targetUserId: userId,
      tenantIds: [a, b],
    });
    for (const tenantId of [a, b]) {
      const rows = await handle.db.select().from(auditLog).where(eq(auditLog.tenantId, tenantId));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        actorType: 'user',
        actorId: userId,
        action: 'mfa.recovery_code_used',
        entityType: 'user',
        entityId: userId,
      });
      expect(JSON.stringify(rows[0])).not.toContain(hex('a'));
    }
  });
});
