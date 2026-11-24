import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import type { DatabaseHandle } from '../src/client.js';
import { receptionEkuatiaGlobalUsage, receptionEkuatiaSolveUsage, tenants } from '../src/schema.js';
import { withTenantTransaction } from '../src/tenant-transaction.js';
import { createTestDatabase, queryRows } from './support/harness.js';

async function causeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    const cause = (error as { cause?: unknown }).cause;
    return cause instanceof Error ? cause.message : String(cause);
  }
  return expect.unreachable('expected the query to reject');
}

function rollbackStatements(file: string): string[] {
  const path = fileURLToPath(new URL(`../migrations/rollback/${file}`, import.meta.url));
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n')
    .split(';')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

/** Spec: reception R6.3. Paid eKuatia solves per tenant and UTC day, and platform-wide per day. */
describe('reception_ekuatia_solve_usage and reception_ekuatia_global_usage', () => {
  let handle: DatabaseHandle | undefined;

  afterEach(async () => {
    await handle?.close();
    handle = undefined;
  });

  async function seed() {
    handle = await createTestDatabase();
    const rows = await handle.db
      .insert(tenants)
      .values([{ name: 'A' }, { name: 'B' }])
      .returning();
    const [a, b] = rows.map((row) => row.id);
    return { db: handle.db, a, b };
  }

  it('keeps one tenant counter per day and rejects a negative one', async () => {
    const { db, a } = await seed();
    await db.insert(receptionEkuatiaSolveUsage).values({ tenantId: a, usageDate: '2026-11-16' });
    expect(
      await causeOf(
        db.insert(receptionEkuatiaSolveUsage).values({ tenantId: a, usageDate: '2026-11-16' }),
      ),
    ).toContain('reception_ekuatia_solve_usage_tenant_id_usage_date_pk');
    expect(
      await causeOf(
        db
          .insert(receptionEkuatiaSolveUsage)
          .values({ tenantId: a, usageDate: '2026-11-17', used: -1 }),
      ),
    ).toContain('reception_ekuatia_solve_usage_used_nonneg');
  });

  it('keeps one global counter per day and rejects a negative one', async () => {
    const { db } = await seed();
    await db.insert(receptionEkuatiaGlobalUsage).values({ usageDate: '2026-11-16' });
    expect(
      await causeOf(db.insert(receptionEkuatiaGlobalUsage).values({ usageDate: '2026-11-16' })),
    ).toContain('reception_ekuatia_global_usage_pkey');
    expect(
      await causeOf(
        db.insert(receptionEkuatiaGlobalUsage).values({ usageDate: '2026-11-17', used: -1 }),
      ),
    ).toContain('reception_ekuatia_global_usage_used_nonneg');
  });

  it('isolates tenant counters with row level security', async () => {
    const { db, a, b } = await seed();
    await db.insert(receptionEkuatiaSolveUsage).values([
      { tenantId: a, usageDate: '2026-11-16', used: 1 },
      { tenantId: b, usageDate: '2026-11-16', used: 2 },
    ]);
    const seenByA = await withTenantTransaction(db, a, (tx) =>
      tx.select().from(receptionEkuatiaSolveUsage),
    );
    expect(seenByA.map((row) => row.tenantId)).toEqual([a]);
    expect(
      await causeOf(
        withTenantTransaction(db, b, (tx) =>
          tx.insert(receptionEkuatiaSolveUsage).values({ tenantId: a, usageDate: '2026-11-17' }),
        ),
      ),
    ).toContain('row-level security');
  });

  it('lets any tenant context read and bump the global counter, but never delete it', async () => {
    const { db, a, b } = await seed();
    await db.insert(receptionEkuatiaGlobalUsage).values({ usageDate: '2026-11-16', used: 1 });
    await withTenantTransaction(db, a, (tx) =>
      tx.update(receptionEkuatiaGlobalUsage).set({ used: 2 }),
    );
    const seenByB = await withTenantTransaction(db, b, (tx) =>
      tx.select().from(receptionEkuatiaGlobalUsage),
    );
    expect(seenByB.map((row) => row.used)).toEqual([2]);
    expect(
      await causeOf(withTenantTransaction(db, a, (tx) => tx.delete(receptionEkuatiaGlobalUsage))),
    ).toContain('permission denied for table reception_ekuatia_global_usage');
  });

  it('gives app_user no way to delete tenant counters, and partner_viewer no access at all', async () => {
    const { db, a } = await seed();
    await db.insert(receptionEkuatiaSolveUsage).values({ tenantId: a, usageDate: '2026-11-16' });
    expect(
      await causeOf(withTenantTransaction(db, a, (tx) => tx.delete(receptionEkuatiaSolveUsage))),
    ).toContain('permission denied for table reception_ekuatia_solve_usage');
    const grants = await queryRows<{ grantee: string }>(
      db,
      sql`select distinct grantee from information_schema.role_table_grants
          where table_name like 'reception_ekuatia_%' and grantee = 'partner_viewer'`,
    );
    expect(grants).toEqual([]);
  });

  it('rolls back cleanly (0084)', async () => {
    const { db } = await seed();
    for (const statement of rollbackStatements('0084_reception_ekuatia_solve_usage.down.sql')) {
      await db.execute(sql.raw(statement));
    }
    const left = await queryRows<{ relname: string }>(
      db,
      sql`select relname from pg_class where relname like 'reception_ekuatia_%'`,
    );
    expect(left).toEqual([]);
  });
});
