import { afterEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import type { DatabaseHandle } from '../src/client.js';
import { partners, tenants } from '../src/schema.js';
import { withPartnerTransaction } from '../src/partner-transaction.js';
import { createTestDatabase, queryRows } from './support/harness.js';

const RECEPTION_TABLES = [
  'received_artifacts',
  'received_documents',
  'received_document_items',
  'received_document_field_confidences',
] as const;

async function causeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    const cause = (error as { cause?: unknown }).cause;
    return cause instanceof Error ? cause.message : String(error);
  }
  return expect.unreachable('expected the query to reject');
}

/**
 * Spec: ADR-0014 / ADR-0024. A partner sees operational metadata of its tenants, never the content of
 * received documents: the `partner_viewer` role has no grant at all on the reception tables.
 */
describe('reception tables are invisible to partner_viewer', () => {
  let handle: DatabaseHandle | undefined;

  afterEach(async () => {
    await handle?.close();
    handle = undefined;
  });

  async function seed() {
    handle = await createTestDatabase();
    const [partner] = await handle.db.insert(partners).values({ name: 'Partner' }).returning();
    await handle.db.insert(tenants).values({ name: 'Own', partnerId: partner.id });
    return { db: handle.db, partnerId: partner.id };
  }

  it('still lets the partner role read its own tenants (the role switch is effective)', async () => {
    const s = await seed();

    const rows = await withPartnerTransaction(s.db, s.partnerId, (tx) =>
      queryRows<{ name: string }>(tx, sql`select name from tenants`),
    );

    expect(rows.map((r) => r.name)).toEqual(['Own']);
  });

  for (const table of RECEPTION_TABLES) {
    it(`denies select, insert, update and delete on ${table}`, async () => {
      const s = await seed();
      const statements = [
        `select * from ${table}`,
        `select count(*) from ${table}`,
        `insert into ${table} default values`,
        `update ${table} set updated_at = now()`,
        `delete from ${table}`,
      ];

      for (const statement of statements) {
        const message = await causeOf(
          withPartnerTransaction(s.db, s.partnerId, (tx) => tx.execute(sql.raw(statement))),
        );
        expect(message, statement).toMatch(/permission denied/i);
      }
    });
  }
});
