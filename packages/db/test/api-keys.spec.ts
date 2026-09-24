import { afterEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import type { Database, DatabaseHandle } from '../src/client.js';
import { apiKeys, tenants } from '../src/schema.js';
import { withTenantTransaction } from '../src/tenant-transaction.js';
import { createTestDatabase, queryRows } from './support/harness.js';

interface Seed {
  db: Database;
  tenantA: string;
  tenantB: string;
  keyIdA: string;
  keyIdB: string;
  revokedKeyId: string;
}

function required<T>(value: T | undefined, message: string): T {
  if (value === undefined) {
    throw new Error(message);
  }
  return value;
}

interface ResolvedApiKey {
  id: string;
  tenant_id: string;
  secret_hash: string;
  scopes: string[];
  environment: string;
}

/**
 * Spec: HU-E1-04 (DB part). `api_keys` is tenant-scoped like every other
 * operational table (ADR-0005), and the pre-authentication lookup
 * (`resolve_api_key` / `touch_api_key_last_used`) is the only sanctioned way
 * to read a key before a tenant context exists — never a direct query.
 */
describe('api_keys', () => {
  let handle: DatabaseHandle | undefined;

  async function seed(): Promise<Seed> {
    const testHandle = await createTestDatabase();
    handle = testHandle;

    const inserted = await testHandle.db
      .insert(tenants)
      .values([{ name: 'Tenant A' }, { name: 'Tenant B' }])
      .returning();
    const tenantA = required(inserted[0], 'tenant A was not inserted').id;
    const tenantB = required(inserted[1], 'tenant B was not inserted').id;

    const [rowA] = await testHandle.db
      .insert(apiKeys)
      .values({
        tenantId: tenantA,
        keyId: 'key_a_active',
        environment: 'live',
        secretHash: '$argon2id$v=19$m=65536,t=3,p=4$c2FsdA$aGFzaA',
        scopes: ['documents:write'],
        label: 'CI key A',
      })
      .returning();
    const [rowB] = await testHandle.db
      .insert(apiKeys)
      .values({
        tenantId: tenantB,
        keyId: 'key_b_active',
        environment: 'live',
        secretHash: '$argon2id$v=19$m=65536,t=3,p=4$c2FsdA$b3RoZXI',
        scopes: [],
      })
      .returning();
    const [revoked] = await testHandle.db
      .insert(apiKeys)
      .values({
        tenantId: tenantA,
        keyId: 'key_a_revoked',
        environment: 'test',
        secretHash: '$argon2id$v=19$m=65536,t=3,p=4$c2FsdA$cmV2b2tlZA',
        scopes: [],
        revokedAt: new Date(),
      })
      .returning();

    return {
      db: testHandle.db,
      tenantA,
      tenantB,
      keyIdA: required(rowA, 'key A was not inserted').id,
      keyIdB: required(rowB, 'key B was not inserted').id,
      revokedKeyId: required(revoked, 'revoked key was not inserted').id,
    };
  }

  afterEach(async () => {
    await handle?.close();
    handle = undefined;
  });

  it('tenant A sees only its own api keys', async () => {
    const { db, tenantA } = await seed();

    const rows = await withTenantTransaction(db, tenantA, (tx) => tx.select().from(apiKeys));

    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.tenantId === tenantA)).toBe(true);
  });

  it('tenant A cannot read or modify tenant B api keys', async () => {
    const { db, tenantA, tenantB } = await seed();

    const rows = await withTenantTransaction(db, tenantA, (tx) =>
      tx.select().from(apiKeys).where(eq(apiKeys.tenantId, tenantB)),
    );
    expect(rows).toHaveLength(0);

    const updated = await withTenantTransaction(db, tenantA, (tx) =>
      tx
        .update(apiKeys)
        .set({ revokedAt: new Date() })
        .where(eq(apiKeys.tenantId, tenantB))
        .returning(),
    );
    expect(updated).toHaveLength(0);
  });

  it('resolve_api_key returns the row for an active key without tenant context', async () => {
    const { db } = await seed();

    const rows = await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL ROLE app_user`);
      return queryRows<ResolvedApiKey>(tx, sql`select * from resolve_api_key('key_a_active')`);
    });

    expect(rows).toHaveLength(1);
    const row = required(rows[0], 'resolve_api_key returned no row');
    expect(Object.keys(row).sort()).toEqual(
      ['environment', 'id', 'scopes', 'secret_hash', 'tenant_id'].sort(),
    );
    expect(row.environment).toBe('live');
    expect(row.secret_hash).toBe('$argon2id$v=19$m=65536,t=3,p=4$c2FsdA$aGFzaA');
  });

  it('resolve_api_key returns nothing for a revoked key', async () => {
    const { db } = await seed();

    const rows = await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL ROLE app_user`);
      return queryRows<ResolvedApiKey>(tx, sql`select * from resolve_api_key('key_a_revoked')`);
    });

    expect(rows).toHaveLength(0);
  });

  it('resolve_api_key returns nothing for an unknown key id', async () => {
    const { db } = await seed();

    const rows = await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL ROLE app_user`);
      return queryRows<ResolvedApiKey>(tx, sql`select * from resolve_api_key('does_not_exist')`);
    });

    expect(rows).toHaveLength(0);
  });

  it('touch_api_key_last_used updates only last_used_at', async () => {
    const { db, keyIdA } = await seed();

    await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL ROLE app_user`);
      await tx.execute(sql`select touch_api_key_last_used(${keyIdA}::uuid)`);
    });

    const rows = await queryRows<{ last_used_at: Date | null; revoked_at: Date | null }>(
      db,
      sql`select last_used_at, revoked_at from api_keys where id = ${keyIdA}::uuid`,
    );
    expect(rows[0]?.last_used_at).not.toBeNull();
    expect(rows[0]?.revoked_at).toBeNull();
  });

  // pglite always connects as a superuser, so role-based EXECUTE privilege
  // checks (has_function_privilege for a role with no grants) need real
  // Postgres; a superuser session always has every privilege regardless of
  // GRANT/REVOKE.
  describe.runIf(process.env.DB_TEST_DRIVER === 'postgres')(
    'resolve_api_key / touch_api_key_last_used hardening',
    () => {
      it('search_path is pinned on both functions', async () => {
        const { db } = await seed();

        const rows = await queryRows<{ proname: string; proconfig: string[] | null }>(
          db,
          sql`select proname, proconfig from pg_proc
              where proname in ('resolve_api_key', 'touch_api_key_last_used')
              order by proname`,
        );

        expect(rows).toHaveLength(2);
        for (const row of rows) {
          expect(row.proconfig).toContain('search_path=pg_catalog, public');
        }
      });

      it('is not executable by PUBLIC: a fresh role with no grants is denied', async () => {
        const { db } = await seed();

        await db.execute(sql`
          do $$
          begin
            if not exists (select 1 from pg_roles where rolname = 'api_keys_probe_role') then
              create role api_keys_probe_role;
            end if;
          end
          $$;
        `);

        const rows = await queryRows<{
          resolve_ok: boolean;
          touch_ok: boolean;
          app_user_ok: boolean;
        }>(
          db,
          sql`select
                has_function_privilege('api_keys_probe_role', 'resolve_api_key(text)', 'EXECUTE') as resolve_ok,
                has_function_privilege('api_keys_probe_role', 'touch_api_key_last_used(uuid)', 'EXECUTE') as touch_ok,
                has_function_privilege('app_user', 'resolve_api_key(text)', 'EXECUTE') as app_user_ok`,
        );

        expect(rows[0]?.resolve_ok).toBe(false);
        expect(rows[0]?.touch_ok).toBe(false);
        expect(rows[0]?.app_user_ok).toBe(true);

        await db.execute(sql`drop role api_keys_probe_role`);
      });
    },
  );
});
