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
describe('MFA runtime functions (migration 0042): bound to a live pending session', () => {
  let handle: DatabaseHandle | undefined;

  afterEach(async () => {
    await handle?.close();
    handle = undefined;
  });

  const PENDING = 'a'.repeat(64);

  /** Ana: confirmed MFA and a live pending session whose token hash is PENDING. */
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
    const future = new Date(Date.now() + 600_000).toISOString();
    await call(
      sql`select create_user_session(${ana}, ${PENDING}, ${'e'.repeat(64)}, ${future}, ${future}, ${future}, false)`,
    );
    return { db, ana, call };
  }

  it('gives app_user no direct access to user_mfa', async () => {
    const { call } = await seed();
    await expect(call(sql`select * from user_mfa`)).rejects.toThrow();
  });

  it('reads the enrolment behind a live pending session, and nothing for any other hash', async () => {
    const { call } = await seed();
    const [row] = await call<{
      sealed: unknown;
      confirmed_at: Date | null;
      last_used_step: string | number;
      recovery_hashes: string[];
    }>(sql`select * from mfa_find(${PENDING})`);
    expect(row.sealed).toEqual(SEALED);
    expect(Number(row.last_used_step)).toBe(10);
    expect(row.recovery_hashes).toHaveLength(2);
    expect(row.confirmed_at).not.toBeNull();
    expect(await call(sql`select * from mfa_find(${'9'.repeat(64)})`)).toEqual([]);
  });

  it('advances the replay step only forward, atomically', async () => {
    const { call } = await seed();
    const advance = async (step: number) =>
      (await call<{ ok: boolean }>(sql`select mfa_advance_step(${PENDING}, ${step}) as ok`))[0].ok;
    expect(await advance(11)).toBe(true);
    expect(await advance(11)).toBe(false);
    expect(await advance(5)).toBe(false);
    const results = await Promise.all([advance(20), advance(20)]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('spends a recovery code exactly once', async () => {
    const { call } = await seed();
    const spend = async (hash: string) =>
      (
        await call<{ ok: boolean }>(
          sql`select mfa_consume_recovery_code(${PENDING}, ${hash}) as ok`,
        )
      )[0].ok;
    expect(await spend(CODE)).toBe(true);
    expect(await spend(CODE)).toBe(false);
    expect(await spend('c'.repeat(64))).toBe(false);
    const results = await Promise.all([spend('b'.repeat(64)), spend('b'.repeat(64))]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  describe('a caller cannot act on a user it holds no live pending session of', () => {
    it.each([
      ['an unknown hash', '9'.repeat(64)],
      ['a hash that is not a session at all', 'not-a-hash'],
    ])('does nothing for %s', async (_name, hash) => {
      const { call, db } = await seed();
      expect(await call(sql`select * from mfa_find(${hash})`)).toEqual([]);
      expect(
        (await call<{ ok: boolean }>(sql`select mfa_advance_step(${hash}, 999) as ok`))[0].ok,
      ).toBe(false);
      expect(
        (
          await call<{ ok: boolean }>(sql`select mfa_consume_recovery_code(${hash}, ${CODE}) as ok`)
        )[0].ok,
      ).toBe(false);
      const [row] = await queryRows<{ s: string; n: number }>(
        db,
        sql`select last_used_step as s, cardinality(recovery_hashes) as n from user_mfa`,
      );
      expect([Number(row.s), row.n]).toEqual([10, 2]);
    });

    it('does nothing once the pending session is verified, revoked or expired', async () => {
      const { call, ana, db } = await seed();
      await call(sql`select revoke_user_sessions(${ana})`);
      expect(await call(sql`select * from mfa_find(${PENDING})`)).toEqual([]);
      expect(
        (await call<{ ok: boolean }>(sql`select mfa_advance_step(${PENDING}, 999) as ok`))[0].ok,
      ).toBe(false);
      const [row] = await queryRows<{ s: string }>(
        db,
        sql`select last_used_step as s from user_mfa`,
      );
      expect(Number(row.s)).toBe(10);
    });

    it("a pending session of one user cannot spend another user's codes or step", async () => {
      const { db, call } = await seed();
      const [bob] = (
        await db
          .insert(users)
          .values({ email: 'bob@example.com', passwordHash: HASH, displayName: 'Bob' })
          .returning()
      ).map((row) => row.id) as [string];
      await db.insert(userMfa).values({ userId: bob, sealed: SEALED });
      await db
        .update(userMfa)
        .set({ confirmedAt: new Date(), lastUsedStep: 50, recoveryHashes: [CODE] })
        .where(sql`user_id = ${bob}`);
      // Ana's pending session spends "her" copy of the same code and advances "her" step only.
      expect(
        (
          await call<{ ok: boolean }>(
            sql`select mfa_consume_recovery_code(${PENDING}, ${CODE}) as ok`,
          )
        )[0].ok,
      ).toBe(true);
      await call(sql`select mfa_advance_step(${PENDING}, 99)`);
      const [row] = await queryRows<{ s: string; n: number }>(
        db,
        sql`select last_used_step as s, cardinality(recovery_hashes) as n from user_mfa where user_id = ${bob}`,
      );
      expect([Number(row.s), row.n]).toEqual([50, 1]);
    });
  });
});
