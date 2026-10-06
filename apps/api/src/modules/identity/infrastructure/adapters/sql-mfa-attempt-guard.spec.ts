import { createPgliteDatabase, userMfa, users, type DatabaseHandle } from '@sifen/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SessionService } from '../../application/session.service.js';
import { hashSessionToken } from '../../domain/session-token.js';
import { SqlMfaAttemptGuard } from './sql-mfa-attempt-guard.js';
import { SqlSessionStore } from './sql-session-store.js';

const HASH = '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHQ$aGFzaA';
const SEALED = {
  v: 1,
  keyId: 'k',
  wrappedKey: 'AA==',
  nonce: 'AA==',
  tag: 'AA==',
  ciphertext: 'AA==',
};
const CONFIG = { accessTtlSeconds: 300, refreshTtlSeconds: 600, absoluteTtlSeconds: 1_200 };

describe('SqlMfaAttemptGuard (migration 0041): bound to a live pending session', () => {
  let handle: DatabaseHandle;
  let sessions: SessionService;
  let counter = 0;

  beforeAll(async () => {
    handle = createPgliteDatabase();
    await handle.migrate();
    sessions = new SessionService(new SqlSessionStore(handle.db), CONFIG);
  });

  afterAll(async () => {
    await handle.close();
  });

  /** An enrolled user, their pending session and a guard bound to it. */
  async function enrolled() {
    counter += 1;
    const [row] = await handle.db
      .insert(users)
      .values({ email: `g${String(counter)}@example.com`, passwordHash: HASH, displayName: 'G' })
      .returning({ id: users.id });
    const id = (row as { id: string }).id;
    await handle.db.insert(userMfa).values({ userId: id, sealed: SEALED });
    await handle.db
      .update(userMfa)
      .set({ confirmedAt: new Date(), lastUsedStep: 1 })
      .where(eq(userMfa.userId, id));
    const pending = await sessions.issue(id, { mfaVerified: false });
    const hash = hashSessionToken(pending?.accessToken ?? '');
    return { id, hash, guard: new SqlMfaAttemptGuard(handle.db, 3, hash) };
  }

  it('allows the cap, then refuses and locks the user', async () => {
    const { guard } = await enrolled();
    expect([await guard.reserve(), await guard.reserve(), await guard.reserve()]).toEqual([
      true,
      true,
      true,
    ]);
    expect(await guard.reserve()).toBe(false);
    expect(await guard.reserve()).toBe(false);
  });

  it('a success resets the count, a lock survives it, and an MFA reset (row removed) unlocks', async () => {
    const { id, guard } = await enrolled();
    await guard.reserve();
    await guard.reserve();
    await guard.succeeded();
    expect([await guard.reserve(), await guard.reserve(), await guard.reserve()]).toEqual([
      true,
      true,
      true,
    ]);
    expect(await guard.reserve()).toBe(false);
    await guard.succeeded();
    expect(await guard.reserve()).toBe(false);
    await handle.db.delete(userMfa).where(eq(userMfa.userId, id));
    await handle.db.insert(userMfa).values({ userId: id, sealed: SEALED });
    expect(await guard.reserve()).toBe(true);
  });

  it('cannot count against or reset another user: a guard bound to no live pending session does nothing', async () => {
    const victim = await enrolled();
    for (let i = 0; i < 2; i += 1) await victim.guard.reserve();
    const stranger = new SqlMfaAttemptGuard(
      handle.db,
      3,
      hashSessionToken('not-a-live-pending-token'),
    );
    expect(await stranger.reserve()).toBe(false);
    await stranger.succeeded();
    // The victim's count (2) was neither raised nor reset: one more attempt is the 3rd, the next is refused.
    expect(await victim.guard.reserve()).toBe(true);
    expect(await victim.guard.reserve()).toBe(false);
  });
});
