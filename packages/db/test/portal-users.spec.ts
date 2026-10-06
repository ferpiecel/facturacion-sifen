import { afterEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import type { Database, DatabaseHandle } from '../src/client.js';
import { tenantMemberships, tenants, users } from '../src/schema.js';
import { withTenantTransaction } from '../src/tenant-transaction.js';
import { createTestDatabase, queryRows } from './support/harness.js';

const HASH = '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHQ$aGFzaA';

async function causeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    const cause = (error as { cause?: unknown }).cause;
    return cause instanceof Error ? cause.message : String(cause);
  }
  return expect.unreachable('expected the query to reject');
}

/** Spec: HU-E1-07 (DB part). Global user identity plus per-tenant role membership. */
describe('users and tenant_memberships', () => {
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
    ).map((row) => row.id);
    const [ana, bob] = (
      await db
        .insert(users)
        .values([
          { email: 'ana@example.com', passwordHash: HASH, displayName: 'Ana' },
          { email: 'bob@example.com', passwordHash: HASH, displayName: 'Bob' },
        ])
        .returning()
    ).map((row) => row.id);
    return { db, a: a, b: b, ana: ana, bob: bob };
  }

  it('stores an Argon2id hash and no other credential column yet', async () => {
    const { db } = await seed();
    const columns = await queryRows<{ column_name: string }>(
      db,
      sql`select column_name from information_schema.columns where table_name = 'users' order by column_name`,
    );
    expect(columns.map((c) => c.column_name)).toEqual(
      [
        'created_at',
        'disabled_at',
        'display_name',
        'email',
        'id',
        'password_hash',
        'updated_at',
      ].sort(),
    );
  });

  it('keeps emails unique and lower-case', async () => {
    const { db } = await seed();
    expect(
      await causeOf(
        db.insert(users).values({ email: 'ANA@example.com', passwordHash: HASH, displayName: 'x' }),
      ),
    ).toContain('users_email_lowercase');
    expect(
      await causeOf(
        db.insert(users).values({ email: 'ana@example.com', passwordHash: HASH, displayName: 'x' }),
      ),
    ).toContain('users_email_key');
  });

  it('refuses a password that is not an Argon2id PHC string', async () => {
    const { db } = await seed();
    expect(
      await causeOf(
        db
          .insert(users)
          .values({ email: 'c@example.com', passwordHash: 'plain', displayName: 'C' }),
      ),
    ).toContain('users_password_hash_argon2id');
  });

  it('gives app_user no access to users (pre-auth lookups go through a resolver)', async () => {
    const { db, a } = await seed();
    expect(await causeOf(withTenantTransaction(db, a, (tx) => tx.select().from(users)))).toContain(
      'permission denied for table users',
    );
  });

  it('forces row level security on both tables', async () => {
    const { db } = await seed();
    const rows = await queryRows<{ relname: string; forced: boolean; enabled: boolean }>(
      db,
      sql`select relname, relforcerowsecurity as forced, relrowsecurity as enabled from pg_class
          where relname in ('users', 'tenant_memberships') order by relname`,
    );
    expect(rows).toEqual([
      { relname: 'tenant_memberships', forced: true, enabled: true },
      { relname: 'users', forced: true, enabled: true },
    ]);
  });

  it('accepts exactly the four roles', async () => {
    const { db, a, ana } = await seed();
    const role = (value: string) =>
      db.execute(
        sql`insert into tenant_memberships (tenant_id, user_id, role) values (${a}, ${ana}, ${value})`,
      );
    expect(await causeOf(role('superadmin'))).toContain('invalid input value for enum');
    for (const value of ['owner', 'admin', 'emisor', 'lector']) {
      await db.execute(sql`delete from tenant_memberships`);
      await role(value);
    }
  });

  it('allows one membership per user and tenant, and one user in many tenants', async () => {
    const { db, a, b, ana } = await seed();
    await db.insert(tenantMemberships).values([
      { tenantId: a, userId: ana, role: 'owner' },
      { tenantId: b, userId: ana, role: 'lector' },
    ]);
    expect(
      await causeOf(
        db.insert(tenantMemberships).values({ tenantId: a, userId: ana, role: 'admin' }),
      ),
    ).toContain('tenant_memberships_tenant_id_user_id_key');
  });

  it('scopes memberships to the active tenant through RLS', async () => {
    const { db, a, b, ana, bob } = await seed();
    await db.insert(tenantMemberships).values([
      { tenantId: a, userId: ana, role: 'owner' },
      { tenantId: b, userId: bob, role: 'emisor' },
    ]);
    const seen = await withTenantTransaction(db, a, (tx: Database) =>
      tx.select().from(tenantMemberships),
    );
    expect(seen.map((row) => row.userId)).toEqual([ana]);
    expect(
      await causeOf(
        withTenantTransaction(db, a, (tx) =>
          tx.insert(tenantMemberships).values({ tenantId: b, userId: ana, role: 'lector' }),
        ),
      ),
    ).toContain('row-level security');
  });

  it('lets a tenant change a role but never move a membership', async () => {
    const { db, a, b, ana, bob } = await seed();
    await db.insert(tenantMemberships).values({ tenantId: a, userId: ana, role: 'lector' });
    await withTenantTransaction(db, a, (tx) => tx.update(tenantMemberships).set({ role: 'admin' }));
    expect(await causeOf(db.update(tenantMemberships).set({ tenantId: b }))).toContain('immutable');
    expect(await causeOf(db.update(tenantMemberships).set({ userId: bob }))).toContain('immutable');
  });
});
