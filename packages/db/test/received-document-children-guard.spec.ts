import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import type { DatabaseHandle } from '../src/client.js';
import {
  receivedDocumentFieldConfidences,
  receivedDocumentItems,
  receivedDocuments,
  tenants,
} from '../src/schema.js';
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

/** Spec: reception R1.4b. Identity columns of the child tables are frozen after insert. */
describe('received document children write guard', () => {
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
    const [docA, docA2, docB] = await handle.db
      .insert(receivedDocuments)
      .values([
        { tenantId: a, source: 'sifen_xml' },
        { tenantId: a, source: 'sifen_xml' },
        { tenantId: b, source: 'sifen_xml' },
      ])
      .returning();
    const [itemRow] = await handle.db
      .insert(receivedDocumentItems)
      .values({ tenantId: a, receivedDocumentId: docA.id, position: 1 })
      .returning();
    const [confidenceRow] = await handle.db
      .insert(receivedDocumentFieldConfidences)
      .values({
        tenantId: a,
        receivedDocumentId: docA.id,
        fieldName: 'issuer_ruc',
        confidence: '0.900',
      })
      .returning();
    return {
      db: handle.db,
      a,
      b,
      docA: docA.id,
      docA2: docA2.id,
      docB: docB.id,
      itemId: itemRow.id,
      confidenceId: confidenceRow.id,
    };
  }

  it('rejects changing id, tenant_id or received_document_id of an item', async () => {
    const { db, a, b, docA2, docB, itemId } = await seed();
    const attempts = [
      { id: crypto.randomUUID() },
      { tenantId: b, receivedDocumentId: docB },
      { receivedDocumentId: docA2 },
    ];
    for (const change of attempts) {
      expect(
        await causeOf(
          db.update(receivedDocumentItems).set(change).where(eq(receivedDocumentItems.id, itemId)),
        ),
      ).toContain('received_document_items: identity columns are immutable');
    }
    // The same attempt as the tenant itself, under RLS.
    expect(
      await causeOf(
        withTenantTransaction(db, a, (tx) =>
          tx.update(receivedDocumentItems).set({ receivedDocumentId: docA2 }),
        ),
      ),
    ).toContain('received_document_items: identity columns are immutable');
  });

  it('rejects changing id, tenant_id or received_document_id of a field confidence', async () => {
    const { db, a, b, docA2, docB, confidenceId } = await seed();
    const attempts = [
      { id: crypto.randomUUID() },
      { tenantId: b, receivedDocumentId: docB },
      { receivedDocumentId: docA2 },
    ];
    for (const change of attempts) {
      expect(
        await causeOf(
          db
            .update(receivedDocumentFieldConfidences)
            .set(change)
            .where(eq(receivedDocumentFieldConfidences.id, confidenceId)),
        ),
      ).toContain('received_document_field_confidences: identity columns are immutable');
    }
    expect(
      await causeOf(
        withTenantTransaction(db, a, (tx) =>
          tx.update(receivedDocumentFieldConfidences).set({ receivedDocumentId: docA2 }),
        ),
      ),
    ).toContain('received_document_field_confidences: identity columns are immutable');
  });

  it('still lets app_user update the other columns under RLS', async () => {
    const { db, a, itemId, confidenceId } = await seed();
    await withTenantTransaction(db, a, async (tx) => {
      await tx
        .update(receivedDocumentItems)
        .set({ description: 'Cafe', quantity: '2' })
        .where(eq(receivedDocumentItems.id, itemId));
      await tx
        .update(receivedDocumentFieldConfidences)
        .set({
          confidence: '0.500',
          correctedValue: '80012345',
          correctedBy: 'key-1',
          correctedAt: new Date(),
        })
        .where(eq(receivedDocumentFieldConfidences.id, confidenceId));
    });
    const [item] = await db.select().from(receivedDocumentItems);
    expect(item).toMatchObject({ description: 'Cafe', id: itemId });
    const [confidence] = await db.select().from(receivedDocumentFieldConfidences);
    expect(confidence).toMatchObject({
      confidence: '0.500',
      correctedValue: '80012345',
      id: confidenceId,
    });
  });

  it('rolls back cleanly: the triggers and function go away and identity edits work again', async () => {
    const { db, docA2, itemId } = await seed();
    for (const statement of rollbackStatements('0079_received_document_children_guard.down.sql')) {
      await db.execute(sql.raw(statement));
    }
    const left = await queryRows<{ name: string }>(
      db,
      sql`select tgname as name from pg_trigger where tgname in ('received_document_items_guard',
            'received_document_field_confidences_guard')
          union all
          select proname from pg_proc where proname in ('received_document_items_guard',
            'received_document_field_confidences_guard')`,
    );
    expect(left).toEqual([]);
    await db
      .update(receivedDocumentItems)
      .set({ receivedDocumentId: docA2 })
      .where(eq(receivedDocumentItems.id, itemId));
  });
});
