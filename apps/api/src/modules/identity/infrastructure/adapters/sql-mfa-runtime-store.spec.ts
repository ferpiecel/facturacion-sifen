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
import { SqlMfaRuntimeStore } from './sql-mfa-runtime-store.js';
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

  beforeAll(async () => {
    handle = createPgliteDatabase();
    await handle.migrate();
    store = new SqlMfaRuntimeStore(handle.db);
    const [row] = await handle.db
      .insert(users)
      .values({ email: 'r@example.com', passwordHash: HASH, displayName: 'R' })
      .returning({ id: users.id });
    userId = (row as { id: string }).id;
    await handle.db.insert(userMfa).values({ userId, sealed: SEALED });
    await handle.db
      .update(userMfa)
      .set({ confirmedAt: new Date(), lastUsedStep: 10, recoveryHashes: [hex('a'), hex('b')] });
  });

  afterAll(async () => {
    await handle.close();
  });

  it('finds the enrolment, and null for a user without one', async () => {
    expect(await store.find(userId)).toMatchObject({
      sealed: SEALED,
      lastUsedStep: 10,
      recoveryHashes: [hex('a'), hex('b')],
    });
    expect((await store.find(userId))?.confirmedAt).toBeInstanceOf(Date);
    expect(await store.find('00000000-0000-4000-8000-000000000000')).toBeNull();
  });

  it('advances the step forward only and consumes a recovery code once', async () => {
    expect(await store.advanceStep(userId, 11)).toBe(true);
    expect(await store.advanceStep(userId, 11)).toBe(false);
    expect(await store.consumeRecoveryCode(userId, hex('a'))).toBe(true);
    expect(await store.consumeRecoveryCode(userId, hex('a'))).toBe(false);
  });

  it('does not support enrolment writes at runtime (enrolment is not available yet)', async () => {
    await expect(store.savePending(userId, SEALED)).rejects.toThrow(/not available/);
    await expect(store.confirm(userId, 1, [], SEALED)).rejects.toThrow(/not available/);
    await expect(store.remove(userId)).rejects.toThrow(/not available/);
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
