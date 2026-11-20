import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import type { DatabaseHandle } from '../src/client.js';
import { receptionExtractionUsage, tenants } from '../src/schema.js';
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

/** Spec: reception R5.9. Extractions queued per tenant and UTC day (the daily spend cap). */
describe('reception_extraction_usage', () => {
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

  it('keeps one counter per tenant and day, starting from the given value', async () => {
    const { db, a } = await seed();
    await db.insert(receptionExtractionUsage).values({ tenantId: a, usageDate: '2026-11-16' });
    const [row] = await db.select().from(receptionExtractionUsage);
    expect(row).toMatchObject({ tenantId: a, usageDate: '2026-11-16', used: 0 });
    await db
      .insert(receptionExtractionUsage)
      .values({ tenantId: a, usageDate: '2026-11-17', used: 3 });
    expect(
      await causeOf(
        db.insert(receptionExtractionUsage).values({ tenantId: a, usageDate: '2026-11-16' }),
      ),
    ).toContain('reception_extraction_usage_tenant_id_usage_date_pk');
  });

  it('rejects a negative counter', async () => {
    const { db, a } = await seed();
    expect(
      await causeOf(
        db
          .insert(receptionExtractionUsage)
          .values({ tenantId: a, usageDate: '2026-11-16', used: -1 }),
      ),
    ).toContain('reception_extraction_usage_used_nonneg');
  });

  it('isolates tenants with row level security', async () => {
    const { db, a, b } = await seed();
    await db.insert(receptionExtractionUsage).values([
      { tenantId: a, usageDate: '2026-11-16', used: 1 },
      { tenantId: b, usageDate: '2026-11-16', used: 2 },
    ]);
    const seenByA = await withTenantTransaction(db, a, (tx) =>
      tx.select().from(receptionExtractionUsage),
    );
    expect(seenByA.map((row) => row.tenantId)).toEqual([a]);
    expect(
      await causeOf(
        withTenantTransaction(db, b, (tx) =>
          tx.insert(receptionExtractionUsage).values({ tenantId: a, usageDate: '2026-11-17' }),
        ),
      ),
    ).toContain('row-level security');
    await withTenantTransaction(db, b, (tx) =>
      tx.update(receptionExtractionUsage).set({ used: 99 }),
    );
    const rows = await db.select().from(receptionExtractionUsage);
    expect(rows.find((row) => row.tenantId === a)?.used).toBe(1);
  });

  it('gives app_user no way to delete, and partner_viewer no access at all', async () => {
    const { db, a } = await seed();
    await db.insert(receptionExtractionUsage).values({ tenantId: a, usageDate: '2026-11-16' });
    expect(
      await causeOf(withTenantTransaction(db, a, (tx) => tx.delete(receptionExtractionUsage))),
    ).toContain('permission denied for table reception_extraction_usage');
    const grants = await queryRows<{ grantee: string }>(
      db,
      sql`select distinct grantee from information_schema.role_table_grants
          where table_name = 'reception_extraction_usage' and grantee = 'partner_viewer'`,
    );
    expect(grants).toEqual([]);
  });

  it('rolls back cleanly: RLS first, then the table (0083)', async () => {
    const { db } = await seed();
    for (const statement of rollbackStatements('0083_reception_extraction_usage.down.sql')) {
      await db.execute(sql.raw(statement));
    }
    const left = await queryRows<{ relname: string }>(
      db,
      sql`select relname from pg_class where relname like 'reception_extraction_usage%'`,
    );
    expect(left).toEqual([]);
  });
});
