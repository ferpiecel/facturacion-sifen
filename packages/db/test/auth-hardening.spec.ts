import { afterEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import type { DatabaseHandle } from '../src/client.js';
import { withAppRoleTransaction } from '../src/app-role-transaction.js';
import { tenants, userMfa, userSessions, users } from '../src/schema.js';
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
const KEY = 'c'.repeat(64);
const h = (c: string): string => c.repeat(64);
const FUTURE = () => new Date(Date.now() + 600_000).toISOString();
const ABSOLUTE = () => new Date(Date.now() + 43_200_000).toISOString();

/** Spec: HU-E1-07 hardening (migration 0041): lock persistence, absolute-cap clamp, revoke-all race, MFA failure cap. */
describe('auth hardening', () => {
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
    await db.insert(tenants).values({ name: 'T' });
    const call = <T>(query: ReturnType<typeof sql>) =>
      withAppRoleTransaction(db, (tx) => queryRows<T>(tx, query));
    const create = async (access: string, refresh: string, mfa: boolean, absolute = ABSOLUTE()) =>
      (
        await call<{ id: string | null }>(
          sql`select create_user_session(${ana}, ${h(access)}, ${h(refresh)}, ${FUTURE()}, ${FUTURE()}, ${absolute}, ${mfa}) as id`,
        )
      )[0].id;
    const resolve = (access: string) => call(sql`select * from resolve_user_session(${h(access)})`);
    const promote = async (pending: string | null, access: string, refresh: string) =>
      (
        await call<{ id: string | null }>(
          sql`select promote_user_session(${pending}, ${h(access)}, ${h(refresh)}, ${FUTURE()}, ${FUTURE()}, ${ABSOLUTE()}) as id`,
        )
      )[0].id;
    const reserve = async (key = KEY, max = 3) =>
      (
        await call<{ ok: boolean }>(
          sql`select auth_throttle_reserve(${key}, ${max}, 900, 900) as ok`,
        )
      )[0].ok;
    return { db, ana, call, create, resolve, promote, reserve };
  }

  describe('throttle lock persistence', () => {
    it('keeps an active lock in force when the window expires', async () => {
      const { db, reserve } = await seed();
      for (let i = 0; i < 3; i += 1) await reserve();
      expect(await reserve()).toBe(false);
      await db.execute(sql`update auth_throttle set window_started_at = now() - interval '1 hour'`);
      expect(await reserve()).toBe(false);
    });

    it('does not extend locked_until when an attempt is refused', async () => {
      const { db, reserve } = await seed();
      for (let i = 0; i < 3; i += 1) await reserve();
      const before = await queryRows<{ locked_until: Date }>(
        db,
        sql`select locked_until from auth_throttle`,
      );
      await reserve();
      await reserve();
      const after = await queryRows<{ locked_until: Date }>(
        db,
        sql`select locked_until from auth_throttle`,
      );
      expect(after[0].locked_until).toEqual(before[0].locked_until);
    });
  });

  describe("promote clamps to the pending session's absolute cap", () => {
    it('never moves the cap later than the login that started the flow', async () => {
      const { db, create, promote } = await seed();
      const cap = new Date(Date.now() + 120_000);
      const pending = await create('a', 'b', false, cap.toISOString());
      await promote(pending, 'c', 'd');
      const [row] = await db
        .select()
        .from(userSessions)
        .where(sql`access_hash = ${h('c')}`);
      expect(row.absoluteExpiresAt.getTime()).toBeLessThanOrEqual(cap.getTime());
    });
  });

  describe('revoke-all versus promote (sessions_valid_after)', () => {
    it("does not resolve a session created before the user's last revoke-all", async () => {
      const { db, ana, create, resolve } = await seed();
      await create('a', 'b', true);
      await db.execute(
        sql`update users set sessions_valid_after = now() + interval '1 minute' where id = ${ana}`,
      );
      expect(await resolve('a')).toEqual([]);
    });

    it('revoke_user_sessions stamps the user so nothing created earlier can come alive', async () => {
      const { db, ana, call, create, promote, resolve } = await seed();
      const pending = await create('a', 'b', false);
      await call(sql`select revoke_user_sessions(${ana})`);
      expect(await promote(pending, 'c', 'd')).toBeNull();
      expect(await resolve('c')).toEqual([]);
      const [row] = await queryRows<{ v: Date }>(
        db,
        sql`select sessions_valid_after as v from users`,
      );
      expect(new Date(row.v).getTime()).toBeGreaterThan(0);
    });

    it('leaves no live verified session when revoke-all races a promotion', async () => {
      const { ana, call } = await seed();
      const hx = (n: number): string => n.toString(16).padStart(64, '0');
      for (let i = 1; i <= 12; i += 1) {
        const [row] = await call<{ id: string }>(
          sql`select create_user_session(${ana}, ${hx(i * 4)}, ${hx(i * 4 + 1)}, ${FUTURE()}, ${FUTURE()}, ${ABSOLUTE()}, false) as id`,
        );
        await Promise.all([
          call(
            sql`select promote_user_session(${row.id}, ${hx(i * 4 + 2)}, ${hx(i * 4 + 3)}, ${FUTURE()}, ${FUTURE()}, ${ABSOLUTE()})`,
          ),
          call(sql`select revoke_user_sessions(${ana})`),
        ]);
        expect(await call(sql`select * from resolve_user_session(${hx(i * 4 + 2)})`)).toEqual([]);
      }
    });
  });

  describe('consecutive MFA failure cap (per user, only a success resets it, only through a live pending session)', () => {
    /** Ana has a confirmed MFA row and a live PENDING session whose token hash is h('a'). */
    async function withMfa() {
      const ctx = await seed();
      await ctx.db.insert(userMfa).values({ userId: ctx.ana, sealed: SEALED });
      await ctx.db.update(userMfa).set({ confirmedAt: new Date(), lastUsedStep: 1 });
      await ctx.create('a', 'b', false);
      const attempt = async (cap = 4, hash = h('a')) =>
        (await ctx.call<{ ok: boolean }>(sql`select mfa_attempt_reserve(${hash}, ${cap}) as ok`))[0]
          .ok;
      const succeeded = (hash = h('a')) => ctx.call(sql`select mfa_attempt_succeeded(${hash})`);
      return { ...ctx, attempt, succeeded };
    }

    it('allows cap attempts, then refuses and locks the user', async () => {
      const { attempt, db } = await withMfa();
      expect([await attempt(), await attempt(), await attempt(), await attempt()]).toEqual([
        true,
        true,
        true,
        true,
      ]);
      expect(await attempt()).toBe(false);
      expect(await attempt()).toBe(false);
      const [row] = await queryRows<{ locked: boolean }>(
        db,
        sql`select mfa_locked_at is not null as locked from user_mfa`,
      );
      expect(row.locked).toBe(true);
    });

    it('counts across windows: only a success resets, never the passing of time', async () => {
      const { attempt, succeeded } = await withMfa();
      await attempt();
      await attempt();
      await succeeded();
      expect([await attempt(), await attempt(), await attempt(), await attempt()]).toEqual([
        true,
        true,
        true,
        true,
      ]);
      expect(await attempt()).toBe(false);
    });

    it('stays locked after a success is reported, until an MFA reset removes the row', async () => {
      const { attempt, succeeded, ana, db } = await withMfa();
      for (let i = 0; i < 5; i += 1) await attempt();
      await succeeded();
      expect(await attempt()).toBe(false);
      await db.delete(userMfa);
      await db.insert(userMfa).values({ userId: ana, sealed: SEALED });
      expect(await attempt()).toBe(true);
    });

    it('lets at most cap of N concurrent attempts through', async () => {
      const { attempt } = await withMfa();
      const results = await Promise.all(Array.from({ length: 30 }, () => attempt(5)));
      expect(results.filter(Boolean)).toHaveLength(5);
    });

    it('does not block a user who has no enrolment row', async () => {
      const { call, create } = await seed();
      await create('a', 'b', false);
      const [row] = await call<{ ok: boolean }>(
        sql`select mfa_attempt_reserve(${h('a')}, 3) as ok`,
      );
      expect(row.ok).toBe(true);
    });

    describe('a caller cannot act on a user it holds no live pending session of', () => {
      it.each([
        ['an unknown hash', async () => h('9')],
        [
          'a verified (non-pending) session',
          async (ctx: { create: (a: string, b: string, m: boolean) => Promise<string | null> }) => {
            await ctx.create('c', 'd', true);
            return h('c');
          },
        ],
      ])('refuses %s and changes nothing', async (_name, prepare) => {
        const ctx = await withMfa();
        const hash = await prepare(ctx);
        expect(await ctx.attempt(4, hash)).toBe(false);
        await ctx.succeeded(hash);
        const [row] = await queryRows<{ n: number }>(
          ctx.db,
          sql`select consecutive_failures as n from user_mfa`,
        );
        expect(row.n).toBe(0);
      });

      it('refuses a revoked or expired pending session', async () => {
        const ctx = await withMfa();
        await ctx.create('e', 'f', false, new Date(Date.now() + 120_000).toISOString());
        await ctx.db
          .update(userSessions)
          .set({ accessExpiresAt: new Date(Date.now() - 1000) })
          .where(sql`access_hash = ${h('e')}`);
        expect(await ctx.attempt(4, h('e'))).toBe(false);
        await ctx.call(sql`select revoke_user_sessions(${ctx.ana})`);
        expect(await ctx.attempt(4, h('a'))).toBe(false);
      });

      it("acts only on the session's own user: another user's count and lock are untouchable", async () => {
        const ctx = await withMfa();
        const [bob] = (
          await ctx.db
            .insert(users)
            .values({ email: 'bob@example.com', passwordHash: HASH, displayName: 'Bob' })
            .returning()
        ).map((row) => row.id) as [string];
        await ctx.db.insert(userMfa).values({ userId: bob, sealed: SEALED });
        await ctx.db
          .update(userMfa)
          .set({ confirmedAt: new Date(), lastUsedStep: 1, consecutiveFailures: 3 })
          .where(sql`user_id = ${bob}`);
        for (let i = 0; i < 4; i += 1) await ctx.attempt(4);
        await ctx.succeeded();
        const rows = await queryRows<{ user_id: string; n: number }>(
          ctx.db,
          sql`select user_id, consecutive_failures as n from user_mfa`,
        );
        expect(rows.find((r) => r.user_id === bob)?.n).toBe(3);
      });
    });
  });
});
