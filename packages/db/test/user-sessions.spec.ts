import { afterEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import type { DatabaseHandle } from '../src/client.js';
import { withAppRoleTransaction } from '../src/app-role-transaction.js';
import { tenantMemberships, tenants, userSessions, users } from '../src/schema.js';
import { createTestDatabase, queryRows } from './support/harness.js';

const HASH = '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHQ$aGFzaA';
const h = (char: string): string => char.repeat(64);
const FUTURE = () => new Date(Date.now() + 600_000);
const ABSOLUTE = () => new Date(Date.now() + 43_200_000);
const PAST = () => new Date(Date.now() - 1_000);

interface SessionRow {
  id: string;
  user_id: string;
  active_tenant_id: string | null;
  mfa_verified_at: Date | null;
  access_expires_at: Date;
  refresh_expires_at: Date;
}

/** Spec: HU-E1-07 S4 (DB part). Opaque tokens stored as SHA-256 only; every access goes through functions. */
describe('user_sessions and its resolver functions', () => {
  let handle: DatabaseHandle | undefined;

  afterEach(async () => {
    await handle?.close();
    handle = undefined;
  });

  async function seed() {
    handle = await createTestDatabase();
    const db = handle.db;
    const [a, b] = (
      await db
        .insert(tenants)
        .values([{ name: 'A' }, { name: 'B' }])
        .returning()
    ).map((row) => row.id) as [string, string];
    const [ana] = (
      await db
        .insert(users)
        .values({ email: 'ana@example.com', passwordHash: HASH, displayName: 'Ana' })
        .returning()
    ).map((row) => row.id) as [string];
    await db.insert(tenantMemberships).values({ tenantId: a, userId: ana, role: 'admin' });
    const call = <T>(query: ReturnType<typeof sql>) =>
      withAppRoleTransaction(db, (tx) => queryRows<T>(tx, query));
    const create = async (
      access: string,
      refresh: string,
      opts: { mfa?: boolean; access?: Date; refresh?: Date; absolute?: Date; user?: string } = {},
    ) => {
      const [row] = await call<{ id: string | null }>(
        sql`select create_user_session(${opts.user ?? ana}, ${h(access)}, ${h(refresh)}, ${(opts.access ?? FUTURE()).toISOString()}, ${(opts.refresh ?? FUTURE()).toISOString()}, ${(opts.absolute ?? ABSOLUTE()).toISOString()}, ${opts.mfa ?? true}) as id`,
      );
      return row.id;
    };
    const resolve = (access: string) =>
      call<SessionRow>(sql`select * from resolve_user_session(${h(access)})`);
    const rotate = (oldRefresh: string, access: string, refresh: string) =>
      call<SessionRow>(
        sql`select * from rotate_user_session(${h(oldRefresh)}, ${h(access)}, ${h(refresh)}, ${FUTURE().toISOString()}, ${FUTURE().toISOString()})`,
      );
    return { db, a, b, ana, call, create, resolve, rotate };
  }

  it('forces RLS and gives app_user no direct access to the table', async () => {
    const { db, call } = await seed();
    const [row] = await queryRows<{ forced: boolean }>(
      db,
      sql`select relforcerowsecurity as forced from pg_class where relname = 'user_sessions'`,
    );
    expect(row).toEqual({ forced: true });
    await expect(call(sql`select * from user_sessions`)).rejects.toThrow();
  });

  it('creates a session for an active user and resolves it by the access hash only', async () => {
    const { create, resolve, ana } = await seed();
    expect(await create('a', 'b')).toMatch(/^[0-9a-f-]{36}$/);
    const [row] = await resolve('a');
    expect(row).toMatchObject({ user_id: ana, active_tenant_id: null });
    expect(new Date(row.refresh_expires_at).getTime()).toBeGreaterThan(Date.now());
    expect(row.mfa_verified_at).not.toBeNull();
    expect(await resolve('b')).toEqual([]);
  });

  it('creates nothing for a disabled user and stops resolving once the user is disabled', async () => {
    const { db, create, resolve, ana } = await seed();
    await create('a', 'b');
    await db
      .update(users)
      .set({ disabledAt: new Date() })
      .where(sql`id = ${ana}`);
    expect(await resolve('a')).toEqual([]);
    expect(await create('c', 'd')).toBeNull();
  });

  it('does not resolve an expired or revoked session', async () => {
    const { call, create, resolve, ana } = await seed();
    await create('a', 'b', { access: PAST() });
    const id = await create('c', 'd');
    expect(await resolve('a')).toEqual([]);
    await call(sql`select revoke_user_session(${id})`);
    expect(await resolve('c')).toEqual([]);
    expect(ana).toBeDefined();
  });

  it('keeps a pending session (MFA not verified) resolvable but unrefreshable', async () => {
    const { create, resolve, rotate } = await seed();
    await create('a', 'b', { mfa: false });
    const [row] = await resolve('a');
    expect(row.mfa_verified_at).toBeNull();
    expect(await rotate('b', 'c', 'd')).toEqual([]);
  });

  it('rotates: a new pair works, the old access and refresh stop working', async () => {
    const { create, resolve, rotate } = await seed();
    await create('a', 'b');
    const [next] = await rotate('b', 'c', 'd');
    expect(next).toBeDefined();
    expect(await resolve('c')).toHaveLength(1);
    expect(await resolve('a')).toEqual([]);
    expect(await rotate('d', 'e', 'f')).toHaveLength(1);
  });

  it('revokes the whole family when an old refresh is reused', async () => {
    const { create, resolve, rotate } = await seed();
    await create('a', 'b');
    await rotate('b', 'c', 'd');
    expect(await rotate('b', 'x', 'y')).toEqual([]);
    expect(await resolve('c')).toEqual([]);
    expect(await rotate('d', 'e', 'f')).toEqual([]);
  });

  it('lets only one of two concurrent refreshes with the same token win', async () => {
    const { create, rotate } = await seed();
    await create('a', 'b');
    const results = await Promise.all([rotate('b', 'c', 'd'), rotate('b', 'e', 'f')]);
    expect(results.filter((rows) => rows.length > 0)).toHaveLength(1);
  });

  it('does not rotate an expired refresh or an unknown one', async () => {
    const { create, rotate } = await seed();
    await create('a', 'b', { access: PAST(), refresh: PAST() });
    expect(await rotate('b', 'c', 'd')).toEqual([]);
    expect(await rotate('z', 'c', 'd')).toEqual([]);
  });

  it('revokes every session of a user and counts them', async () => {
    const { call, create, resolve, ana } = await seed();
    await create('a', 'b');
    await create('c', 'd');
    const [row] = await call<{ n: number }>(sql`select revoke_user_sessions(${ana}) as n`);
    expect(row.n).toBe(2);
    expect(await resolve('a')).toEqual([]);
    expect(await resolve('c')).toEqual([]);
  });

  it("lists a user's memberships with tenant names and roles", async () => {
    const { call, ana, a } = await seed();
    const rows = await call<{ tenant_id: string; tenant_name: string; role: string }>(
      sql`select * from list_user_memberships(${ana})`,
    );
    expect(rows).toEqual([{ tenant_id: a, tenant_name: 'A', role: 'admin' }]);
  });

  it("selects the active tenant only among the user's tenants and only once MFA is verified", async () => {
    const { call, create, resolve, rotate, a, b } = await seed();
    const id = await create('a', 'b');
    const pending = await create('e', 'f', { mfa: false });
    const select = async (session: string | null, tenant: string) =>
      (
        await call<{ ok: boolean }>(
          sql`select set_user_session_tenant(${session}, ${tenant}) as ok`,
        )
      )[0]?.ok;
    expect(await select(id, b)).toBe(false);
    expect(await select(pending, a)).toBe(false);
    expect(await select(id, a)).toBe(true);
    expect((await resolve('a'))[0]?.active_tenant_id).toBe(a);
    await rotate('b', 'c', 'd');
    expect((await resolve('c'))[0]?.active_tenant_id).toBe(a);
  });

  describe('absolute session lifetime (decided by the PO)', () => {
    it('clamps the expiries of the first generation to the absolute cap', async () => {
      const { db, create } = await seed();
      const cap = new Date(Date.now() + 120_000);
      await create('a', 'b', {
        access: new Date(Date.now() + 300_000),
        refresh: new Date(Date.now() + 600_000),
        absolute: cap,
      });
      const [row] = await db.select().from(userSessions);
      expect(row.accessExpiresAt.getTime()).toBeLessThanOrEqual(cap.getTime());
      expect(row.refreshExpiresAt.getTime()).toBeLessThanOrEqual(cap.getTime());
      expect(row.absoluteExpiresAt.getTime()).toBe(cap.getTime());
    });

    it('lets a refresh right before the cap succeed, with expiries clamped to it', async () => {
      const { db, create, rotate, resolve } = await seed();
      const cap = new Date(Date.now() + 5_000);
      await create('a', 'b', { absolute: cap });
      expect(await rotate('b', 'c', 'd')).toHaveLength(1);
      const [next] = await db
        .select()
        .from(userSessions)
        .where(sql`access_hash = ${h('c')}`);
      expect(next.absoluteExpiresAt.getTime()).toBe(cap.getTime());
      expect(next.accessExpiresAt.getTime()).toBeLessThanOrEqual(cap.getTime());
      expect(next.refreshExpiresAt.getTime()).toBeLessThanOrEqual(cap.getTime());
      expect(await resolve('c')).toHaveLength(1);
    });

    it('refuses a refresh after the cap even when the refresh token itself is still valid', async () => {
      const { db, create, rotate, resolve } = await seed();
      await create('a', 'b');
      await db.update(userSessions).set({ absoluteExpiresAt: PAST() });
      expect(await rotate('b', 'c', 'd')).toEqual([]);
      expect(await resolve('a')).toEqual([]);
    });
  });
});
