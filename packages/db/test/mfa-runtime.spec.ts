import { afterEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import type { DatabaseHandle } from '../src/client.js';
import { withAppRoleTransaction } from '../src/app-role-transaction.js';
import { userMfa, users } from '../src/schema.js';
import { createTestDatabase, queryRows } from './support/harness.js';

const HASH = '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHQ$aGFzaA';
const SEALED = {
  v: 1,
  keyId: 'k',
  wrappedKey: 'AA==',
  nonce: 'AA==',
  tag: 'AA==',
  ciphertext: 'AA==',
};
const CODE = 'a'.repeat(64);

/** Spec: HU-E1-07 (login runtime). The app_user path reads and spends MFA state only through functions. */
describe('MFA runtime functions (migration 0042)', () => {
  let handle: DatabaseHandle | undefined;

  afterEach(async () => {
    await handle?.close();
    handle = undefined;
  });

  async function seed() {
    handle = await createTestDatabase();
    const db = handle.db;
    const [ana] = (
      await db
        .insert(users)
        .values({ email: 'ana@example.com', passwordHash: HASH, displayName: 'Ana' })
        .returning()
    ).map((row) => row.id) as [string];
    await db.insert(userMfa).values({ userId: ana, sealed: SEALED });
    await db
      .update(userMfa)
      .set({ confirmedAt: new Date(), lastUsedStep: 10, recoveryHashes: [CODE, 'b'.repeat(64)] });
    const call = <T>(query: ReturnType<typeof sql>) =>
      withAppRoleTransaction(db, (tx) => queryRows<T>(tx, query));
    return { db, ana, call };
  }

  it('gives app_user no direct access to user_mfa', async () => {
    const { call } = await seed();
    await expect(call(sql`select * from user_mfa`)).rejects.toThrow();
  });

  it('reads the enrolment of a user, and nothing for a user without one', async () => {
    const { call, ana } = await seed();
    const [row] = await call<{
      sealed: unknown;
      confirmed_at: Date | null;
      last_used_step: string | number;
      recovery_hashes: string[];
    }>(sql`select * from mfa_find(${ana})`);
    expect(row.sealed).toEqual(SEALED);
    expect(Number(row.last_used_step)).toBe(10);
    expect(row.recovery_hashes).toHaveLength(2);
    expect(row.confirmed_at).not.toBeNull();
    expect(await call(sql`select * from mfa_find('00000000-0000-4000-8000-000000000000')`)).toEqual(
      [],
    );
  });

  it('advances the replay step only forward, atomically', async () => {
    const { call, ana } = await seed();
    const advance = async (step: number) =>
      (await call<{ ok: boolean }>(sql`select mfa_advance_step(${ana}, ${step}) as ok`))[0].ok;
    expect(await advance(11)).toBe(true);
    expect(await advance(11)).toBe(false);
    expect(await advance(5)).toBe(false);
    const results = await Promise.all([advance(20), advance(20)]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('spends a recovery code exactly once', async () => {
    const { call, ana } = await seed();
    const spend = async (hash: string) =>
      (await call<{ ok: boolean }>(sql`select mfa_consume_recovery_code(${ana}, ${hash}) as ok`))[0]
        .ok;
    expect(await spend(CODE)).toBe(true);
    expect(await spend(CODE)).toBe(false);
    expect(await spend('c'.repeat(64))).toBe(false);
    const results = await Promise.all([spend('b'.repeat(64)), spend('b'.repeat(64))]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });
});
