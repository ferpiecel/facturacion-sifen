import { createPgliteDatabase, userMfa, users, type DatabaseHandle } from '@sifen/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SqlMfaAttemptGuard } from './sql-mfa-attempt-guard.js';

const HASH = '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHQ$aGFzaA';
const SEALED = {
  v: 1,
  keyId: 'k',
  wrappedKey: 'AA==',
  nonce: 'AA==',
  tag: 'AA==',
  ciphertext: 'AA==',
};

describe('SqlMfaAttemptGuard (migration 0041)', () => {
  let handle: DatabaseHandle;
  let guard: SqlMfaAttemptGuard;
  let counter = 0;

  beforeAll(async () => {
    handle = createPgliteDatabase();
    await handle.migrate();
    guard = new SqlMfaAttemptGuard(handle.db, 3);
  });

  afterAll(async () => {
    await handle.close();
  });

  async function enrolledUser(): Promise<string> {
    counter += 1;
    const [row] = await handle.db
      .insert(users)
      .values({ email: `g${String(counter)}@example.com`, passwordHash: HASH, displayName: 'G' })
      .returning({ id: users.id });
    const id = (row as { id: string }).id;
    await handle.db.insert(userMfa).values({ userId: id, sealed: SEALED });
    return id;
  }

  it('allows the cap, then refuses and locks the user', async () => {
    const id = await enrolledUser();
    expect([await guard.reserve(id), await guard.reserve(id), await guard.reserve(id)]).toEqual([
      true,
      true,
      true,
    ]);
    expect(await guard.reserve(id)).toBe(false);
    expect(await guard.reserve(id)).toBe(false);
  });

  it('a success resets the count, a lock survives it, and an MFA reset (row removed) unlocks', async () => {
    const id = await enrolledUser();
    await guard.reserve(id);
    await guard.reserve(id);
    await guard.succeeded(id);
    expect([await guard.reserve(id), await guard.reserve(id), await guard.reserve(id)]).toEqual([
      true,
      true,
      true,
    ]);
    expect(await guard.reserve(id)).toBe(false);
    await guard.succeeded(id);
    expect(await guard.reserve(id)).toBe(false);
    await handle.db.delete(userMfa).where(eq(userMfa.userId, id));
    await handle.db.insert(userMfa).values({ userId: id, sealed: SEALED });
    expect(await guard.reserve(id)).toBe(true);
  });
});
