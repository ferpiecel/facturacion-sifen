import { afterEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import type { DatabaseHandle } from '../src/client.js';
import { withAppRoleTransaction } from '../src/app-role-transaction.js';
import { users } from '../src/schema.js';
import { createTestDatabase, queryRows } from './support/harness.js';

const HASH = '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHQ$aGFzaA';
const h = (c: string): string => c.repeat(64);
const FUTURE = () => new Date(Date.now() + 600_000).toISOString();

/** Spec: HU-E1-07 (logout). A refresh token alone can end its whole session family. */
describe('revoke_session_family', () => {
  let handle: DatabaseHandle | undefined;

  afterEach(async () => {
    await handle?.close();
    handle = undefined;
  });

  async function seed() {
    handle = await createTestDatabase();
    const [ana] = (
      await handle.db
        .insert(users)
        .values({ email: 'ana@example.com', passwordHash: HASH, displayName: 'Ana' })
        .returning()
    ).map((row) => row.id) as [string];
    const call = <T>(query: ReturnType<typeof sql>) =>
      withAppRoleTransaction(handle!.db, (tx) => queryRows<T>(tx, query));
    await call(
      sql`select create_user_session(${ana}, ${h('a')}, ${h('b')}, ${FUTURE()}, ${FUTURE()}, ${FUTURE()}, true)`,
    );
    const live = async (access: string) =>
      (await call(sql`select * from resolve_user_session(${h(access)})`)).length;
    return { call, live };
  }

  it('revokes every generation of the family from the current or an old refresh token', async () => {
    const { call, live } = await seed();
    await call(
      sql`select * from rotate_user_session(${h('b')}, ${h('c')}, ${h('d')}, ${FUTURE()}, ${FUTURE()})`,
    );
    expect(await live('c')).toBe(1);
    const [row] = await call<{ n: number }>(sql`select revoke_session_family(${h('b')}) as n`);
    expect(row.n).toBeGreaterThanOrEqual(1);
    expect(await live('c')).toBe(0);
    expect(await live('a')).toBe(0);
  });

  it('does nothing for an unknown refresh token and only touches its own family', async () => {
    const { call, live } = await seed();
    const [none] = await call<{ n: number }>(sql`select revoke_session_family(${h('9')}) as n`);
    expect(none.n).toBe(0);
    expect(await live('a')).toBe(1);
  });
});
