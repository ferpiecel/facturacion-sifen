import { afterEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import type { DatabaseHandle } from '../src/client.js';
import { withAppRoleTransaction } from '../src/app-role-transaction.js';
import { authEvents, users } from '../src/schema.js';
import { createTestDatabase, queryRows } from './support/harness.js';

const HASH = '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHQ$aGFzaA';
const KEY = 'a'.repeat(64);

/** Spec: HU-E1-07 S4 (login support): throttling, pre-tenant auth events and credential lookup. */
describe('auth throttle, auth events and credential lookup', () => {
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
    const call = <T>(query: ReturnType<typeof sql>) =>
      withAppRoleTransaction(db, (tx) => queryRows<T>(tx, query));
    const fail = async (key = KEY, max = 3) =>
      (
        await call<{ locked: boolean }>(
          sql`select auth_throttle_fail(${key}, ${max}, 900, 900) as locked`,
        )
      )[0].locked;
    const locked = async (key = KEY) =>
      (await call<{ locked: boolean }>(sql`select auth_throttle_locked(${key}) as locked`))[0]
        .locked;
    return { db, ana, call, fail, locked };
  }

  it('forces RLS and gives app_user no direct access to the new tables', async () => {
    const { db, call } = await seed();
    const rows = await queryRows<{ relname: string; forced: boolean }>(
      db,
      sql`select relname, relforcerowsecurity as forced from pg_class where relname in ('auth_throttle', 'auth_events') order by relname`,
    );
    expect(rows).toEqual([
      { relname: 'auth_events', forced: true },
      { relname: 'auth_throttle', forced: true },
    ]);
    await expect(call(sql`select * from auth_throttle`)).rejects.toThrow();
    await expect(call(sql`select * from auth_events`)).rejects.toThrow();
  });

  it('locks a key at the configured number of failures and not before', async () => {
    const { fail, locked } = await seed();
    expect(await locked()).toBe(false);
    expect(await fail()).toBe(false);
    expect(await fail()).toBe(false);
    expect(await locked()).toBe(false);
    expect(await fail()).toBe(true);
    expect(await locked()).toBe(true);
  });

  it('keeps keys independent and clears a key on success', async () => {
    const { call, fail, locked } = await seed();
    await fail();
    await fail();
    await fail();
    expect(await locked('b'.repeat(64))).toBe(false);
    await call(sql`select auth_throttle_clear(${KEY})`);
    expect(await locked()).toBe(false);
    expect(await fail()).toBe(false);
  });

  it('starts a fresh window once the previous one has expired', async () => {
    const { db, fail, locked } = await seed();
    await fail();
    await fail();
    await db.execute(sql`update auth_throttle set window_started_at = now() - interval '1 hour'`);
    expect(await fail()).toBe(false);
    expect(await locked()).toBe(false);
  });

  it('releases the lock when it has expired', async () => {
    const { db, fail, locked } = await seed();
    await fail();
    await fail();
    await fail();
    await db.execute(sql`update auth_throttle set locked_until = now() - interval '1 second'`);
    expect(await locked()).toBe(false);
  });

  it('refuses malformed keys', async () => {
    const { call } = await seed();
    await expect(
      call(sql`select auth_throttle_fail('not-a-digest', 5, 900, 900)`),
    ).rejects.toThrow();
  });

  it('records pre-tenant auth events, with or without a user, and never overwrites them', async () => {
    const { db, call, ana } = await seed();
    await call(
      sql`select record_auth_event(${ana}, ${KEY}, 'login.succeeded', '{"step":"mfa"}'::jsonb)`,
    );
    await call(sql`select record_auth_event(null, ${KEY}, 'login.password_failed', '{}'::jsonb)`);
    const rows = await db.select().from(authEvents);
    expect(rows.map((r) => [r.userId, r.event])).toEqual(
      expect.arrayContaining([
        [ana, 'login.succeeded'],
        [null, 'login.password_failed'],
      ]),
    );
    expect(rows).toHaveLength(2);
    await expect(db.update(authEvents).set({ event: 'x' })).rejects.toThrow();
    await expect(db.delete(authEvents)).rejects.toThrow();
  });

  it('looks credentials up by email for the pre-auth path', async () => {
    const { db, call, ana } = await seed();
    const found = () =>
      call<{ id: string; password_hash: string; disabled: boolean }>(
        sql`select * from resolve_user_credentials('ana@example.com')`,
      );
    expect(await found()).toEqual([{ id: ana, password_hash: HASH, disabled: false }]);
    await db.update(users).set({ disabledAt: new Date() });
    expect((await found())[0].disabled).toBe(true);
    expect(await call(sql`select * from resolve_user_credentials('nobody@example.com')`)).toEqual(
      [],
    );
  });
});
