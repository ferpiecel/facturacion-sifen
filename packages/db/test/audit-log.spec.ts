import { afterEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import type { DatabaseHandle } from '../src/client.js';
import { auditLog, tenants } from '../src/schema.js';
import { withTenantTransaction } from '../src/tenant-transaction.js';
import { connectAsRuntime, createTestDatabase, queryRows } from './support/harness.js';

function required<T>(value: T | undefined, message: string): T {
  if (value === undefined) {
    throw new Error(message);
  }
  return value;
}

function causeMessage(error: unknown): string {
  const cause = error instanceof Error ? (error.cause ?? error) : error;
  return cause instanceof Error ? cause.message : String(cause);
}

/** Spec: HU-E13-01 (DB part). Tenant-scoped, append-only audit trail (RF-16, RNF-08). */
describe('audit_log', () => {
  let handle: DatabaseHandle | undefined;

  async function seed() {
    const testHandle = await createTestDatabase();
    handle = testHandle;
    const inserted = await testHandle.db
      .insert(tenants)
      .values([{ name: 'Tenant A' }, { name: 'Tenant B' }])
      .returning();
    const tenantA = required(inserted[0], 'tenant A was not inserted').id;
    const tenantB = required(inserted[1], 'tenant B was not inserted').id;
    const entry = (tenantId: string) => ({
      tenantId,
      actorType: 'api_key' as const,
      actorId: 'key-1',
      action: 'fiscal_profile.update',
      entityType: 'fiscal_profile',
      entityId: 'fp-1',
      before: { name: 'Old' },
      after: { name: 'New' },
    });
    await withTenantTransaction(testHandle.db, tenantA, (tx) =>
      tx.insert(auditLog).values(entry(tenantA)),
    );
    await withTenantTransaction(testHandle.db, tenantB, (tx) =>
      tx.insert(auditLog).values(entry(tenantB)),
    );
    return { db: testHandle.db, tenantA, tenantB, entry };
  }

  afterEach(async () => {
    await handle?.close();
    handle = undefined;
  });

  it('declares the expected constraint names', async () => {
    const { db } = await seed();

    const rows = await queryRows<{ conname: string }>(
      db,
      sql`select conname from pg_constraint where conrelid = 'audit_log'::regclass and contype <> 'n' order by conname`,
    );

    expect(rows.map((row) => row.conname)).toEqual([
      'audit_log_action_not_blank',
      'audit_log_entity_id_not_blank',
      'audit_log_pkey',
      'audit_log_tenant_id_tenants_id_fk',
      'audit_log_tenant_seq_unique',
    ]);
  });

  it('rejects a blank action', async () => {
    const { db, tenantA, entry } = await seed();

    const error: unknown = await withTenantTransaction(db, tenantA, (tx) =>
      tx.insert(auditLog).values({ ...entry(tenantA), action: '' }),
    ).catch((caught: unknown) => caught);

    expect(causeMessage(error)).toMatch(/audit_log_action_not_blank/);
  });

  it('tenant A reads only its own audit rows', async () => {
    const { db, tenantA } = await seed();

    const rows = await withTenantTransaction(db, tenantA, (tx) => tx.select().from(auditLog));

    expect(rows).toHaveLength(1);
    expect(rows[0]?.tenantId).toBe(tenantA);
    expect(rows[0]?.after).toEqual({ name: 'New' });
  });

  it('tenant A cannot insert an audit row for tenant B', async () => {
    const { db, tenantA, tenantB, entry } = await seed();

    const error: unknown = await withTenantTransaction(db, tenantA, (tx) =>
      tx.insert(auditLog).values(entry(tenantB)),
    ).catch((caught: unknown) => caught);

    expect(causeMessage(error)).toMatch(/row-level security/i);
  });

  it('app_user has no UPDATE grant', async () => {
    const { db, tenantA } = await seed();

    const error: unknown = await withTenantTransaction(db, tenantA, (tx) =>
      tx.update(auditLog).set({ action: 'tampered' }),
    ).catch((caught: unknown) => caught);

    expect(causeMessage(error)).toMatch(/permission denied for table audit_log/);
  });

  it('app_user has no DELETE grant', async () => {
    const { db, tenantA } = await seed();

    const error: unknown = await withTenantTransaction(db, tenantA, (tx) =>
      tx.delete(auditLog),
    ).catch((caught: unknown) => caught);

    expect(causeMessage(error)).toMatch(/permission denied for table audit_log/);
  });

  it('the trigger rejects UPDATE, DELETE and TRUNCATE for the connection role (superuser)', async () => {
    const { db } = await seed();

    for (const statement of [
      sql`update audit_log set action = 'tampered'`,
      sql`delete from audit_log`,
      sql`truncate audit_log`,
    ]) {
      const error: unknown = await db.execute(statement).catch((caught: unknown) => caught);
      expect(causeMessage(error)).toMatch(/audit_log is append-only/);
    }
    const remaining = await queryRows<{ count: string }>(
      db,
      sql`select count(*)::text as count from audit_log`,
    );
    expect(remaining[0]?.count).toBe('2');
  });

  it('the documented audit_maintenance role can delete rows', async () => {
    const { db } = await seed();

    const deleted = await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL ROLE audit_maintenance`);
      return queryRows<{ id: string }>(tx, sql`delete from audit_log returning id`);
    });

    expect(deleted).toHaveLength(2);
  });

  it('platform_admin cannot UPDATE or DELETE audit rows', async () => {
    const { db } = await seed();

    for (const statement of [
      sql`update audit_log set action = 'tampered'`,
      sql`delete from audit_log`,
    ]) {
      const error: unknown = await db
        .transaction(async (tx) => {
          await tx.execute(sql`SET LOCAL ROLE platform_admin`);
          await tx.execute(statement);
        })
        .catch((caught: unknown) => caught);
      expect(causeMessage(error)).toMatch(/permission denied for table audit_log/);
    }
  });

  it('rejects an INSERT without tenant context', async () => {
    const { db, tenantA, entry } = await seed();

    const error: unknown = await db
      .transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL ROLE app_user`);
        await tx.insert(auditLog).values(entry(tenantA));
      })
      .catch((caught: unknown) => caught);

    expect(causeMessage(error)).toMatch(/row-level security/i);
  });

  it('forces occurred_at to now() so entries cannot be backdated', async () => {
    const { db, tenantA, entry } = await seed();
    const backdated = new Date('2000-01-01T00:00:00Z');

    const rows = await withTenantTransaction(db, tenantA, (tx) =>
      tx
        .insert(auditLog)
        .values({ ...entry(tenantA), occurredAt: backdated })
        .returning({ occurredAt: auditLog.occurredAt }),
    );

    expect(rows[0]?.occurredAt.getTime()).toBeGreaterThan(Date.now() - 60_000);
  });

  it('pins search_path on both trigger functions', async () => {
    const { db } = await seed();

    const rows = await queryRows<{ proname: string; proconfig: string[] | null }>(
      db,
      sql`select proname, proconfig from pg_proc
          where proname in ('audit_log_reject_mutation', 'audit_log_force_occurred_at')
          order by proname`,
    );

    expect(rows.map((row) => row.proname)).toEqual([
      'audit_log_force_occurred_at',
      'audit_log_reject_mutation',
    ]);
    for (const row of rows) {
      expect(row.proconfig).toContain('search_path=pg_catalog, pg_temp');
    }
  });

  // pglite always connects as a superuser; role membership needs real Postgres.
  // global-setup pre-creates audit_maintenance and grants it to app_login.
  it.runIf(process.env.DB_TEST_DRIVER === 'postgres')(
    'app_login cannot SET ROLE audit_maintenance, even if it was a member before the migration',
    async () => {
      const { db } = await seed();
      const runtime = connectAsRuntime(required(handle, 'owner handle missing'));
      try {
        const members = await queryRows<{ member: string }>(
          db,
          sql`select m.member::regrole::text as member from pg_auth_members m
              where m.roleid = 'audit_maintenance'::regrole`,
        );
        expect(members).toEqual([]);

        const error: unknown = await runtime.db
          .transaction(async (tx) => {
            await tx.execute(sql`SET LOCAL ROLE audit_maintenance`);
          })
          .catch((caught: unknown) => caught);

        expect(causeMessage(error)).toMatch(/permission denied to set role "audit_maintenance"/);
      } finally {
        await runtime.close();
      }
    },
  );
});
