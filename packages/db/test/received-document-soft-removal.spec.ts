import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import type { DatabaseHandle } from '../src/client.js';
import { receivedDocumentItems, receivedDocuments, tenants } from '../src/schema.js';
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

/** Statements are separated by `--> statement-breakpoint` (function bodies contain semicolons). */
function rollbackStatements(file: string): string[] {
  const path = fileURLToPath(new URL(`../migrations/rollback/${file}`, import.meta.url));
  return readFileSync(path, 'utf8')
    .split('--> statement-breakpoint')
    .map((chunk) =>
      chunk
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('--'))
        .join('\n')
        .trim(),
    )
    .filter((statement) => statement.length > 0);
}

/** Spec: reception R4.4. Soft removal of items and correction metadata on the document. */
describe('received document soft removal and correction metadata', () => {
  let handle: DatabaseHandle | undefined;

  afterEach(async () => {
    await handle?.close();
    handle = undefined;
  });

  async function seed() {
    handle = await createTestDatabase();
    const [tenant] = await handle.db.insert(tenants).values({ name: 'A' }).returning();
    const [doc] = await handle.db
      .insert(receivedDocuments)
      .values({ tenantId: tenant.id, source: 'sifen_xml' })
      .returning();
    const [row] = await handle.db
      .insert(receivedDocumentItems)
      .values({
        tenantId: tenant.id,
        receivedDocumentId: doc.id,
        position: 1,
        description: 'Cafe',
        subtotal: '100',
      })
      .returning();
    return { db: handle.db, tenantId: tenant.id, docId: doc.id, itemId: row.id };
  }

  const removeNow = (itemId: string) => ({ removedAt: new Date(), removedBy: `key-${itemId}` });

  it('lets app_user soft-remove an item once, keeping the row', async () => {
    const { db, tenantId, itemId } = await seed();
    await withTenantTransaction(db, tenantId, (tx) =>
      tx
        .update(receivedDocumentItems)
        .set(removeNow(itemId))
        .where(eq(receivedDocumentItems.id, itemId)),
    );
    const [row] = await db.select().from(receivedDocumentItems);
    expect(row.removedAt).toBeInstanceOf(Date);
    expect(row.removedBy).toBe(`key-${itemId}`);
    expect(row.description).toBe('Cafe');
  });

  it('still refuses DELETE for app_user (fiscal retention)', async () => {
    const { db, tenantId } = await seed();
    expect(
      await causeOf(withTenantTransaction(db, tenantId, (tx) => tx.delete(receivedDocumentItems))),
    ).toContain('permission denied for table received_document_items');
  });

  it('keeps removed_at and removed_by together', async () => {
    const { db, itemId } = await seed();
    expect(
      await causeOf(
        db
          .update(receivedDocumentItems)
          .set({ removedAt: new Date() })
          .where(eq(receivedDocumentItems.id, itemId)),
      ),
    ).toContain('received_document_items_removal_pair');
  });

  it('never un-removes and never rewrites the removal', async () => {
    const { db, tenantId, itemId } = await seed();
    await db
      .update(receivedDocumentItems)
      .set(removeNow(itemId))
      .where(eq(receivedDocumentItems.id, itemId));
    for (const change of [
      { removedAt: null, removedBy: null },
      { removedAt: new Date(0), removedBy: 'other' },
    ]) {
      expect(
        await causeOf(
          withTenantTransaction(db, tenantId, (tx) =>
            tx
              .update(receivedDocumentItems)
              .set(change)
              .where(eq(receivedDocumentItems.id, itemId)),
          ),
        ),
      ).toContain('received_document_items: a removed item is frozen');
    }
  });

  it('freezes every other column of a removed item', async () => {
    const { db, tenantId, itemId } = await seed();
    await db
      .update(receivedDocumentItems)
      .set(removeNow(itemId))
      .where(eq(receivedDocumentItems.id, itemId));
    expect(
      await causeOf(
        withTenantTransaction(db, tenantId, (tx) =>
          tx
            .update(receivedDocumentItems)
            .set({ description: 'Te' })
            .where(eq(receivedDocumentItems.id, itemId)),
        ),
      ),
    ).toContain('received_document_items: a removed item is frozen');
  });

  it('refuses to change business columns in the same update that removes the item', async () => {
    const { db, tenantId, itemId } = await seed();
    expect(
      await causeOf(
        withTenantTransaction(db, tenantId, (tx) =>
          tx
            .update(receivedDocumentItems)
            .set({ ...removeNow(itemId), description: 'Te' })
            .where(eq(receivedDocumentItems.id, itemId)),
        ),
      ),
    ).toContain('received_document_items: removal cannot change other columns');
  });

  it('still allows correcting an active item and bumping updated_at', async () => {
    const { db, tenantId, itemId } = await seed();
    await withTenantTransaction(db, tenantId, (tx) =>
      tx
        .update(receivedDocumentItems)
        .set({ description: 'Te', subtotal: '120', updatedAt: new Date() })
        .where(eq(receivedDocumentItems.id, itemId)),
    );
    const [row] = await db.select().from(receivedDocumentItems);
    expect(row).toMatchObject({ description: 'Te', removedAt: null });
  });

  it('stores correction metadata on the document, as a pair', async () => {
    const { db, tenantId, docId } = await seed();
    await withTenantTransaction(db, tenantId, (tx) =>
      tx
        .update(receivedDocuments)
        .set({ correctedAt: new Date(), correctedBy: 'key-1' })
        .where(eq(receivedDocuments.id, docId)),
    );
    const [doc] = await db.select().from(receivedDocuments);
    expect(doc.correctedBy).toBe('key-1');
    expect(
      await causeOf(
        db
          .update(receivedDocuments)
          .set({ correctedAt: null })
          .where(eq(receivedDocuments.id, docId)),
      ),
    ).toContain('received_documents_correction_pair');
  });

  it('rolls back newest first: guard back to identity-only, then the columns go away', async () => {
    const { db, itemId } = await seed();
    for (const statement of rollbackStatements(
      '0054_received_document_items_removal_guard.down.sql',
    )) {
      await db.execute(sql.raw(statement));
    }
    // The 0052 guard is back: removed rows are no longer frozen.
    await db
      .update(receivedDocumentItems)
      .set({ ...removeNow(itemId) })
      .where(eq(receivedDocumentItems.id, itemId));
    await db
      .update(receivedDocumentItems)
      .set({ removedAt: null, removedBy: null, description: 'Te' })
      .where(eq(receivedDocumentItems.id, itemId));
    for (const statement of rollbackStatements('0053_received_document_corrections.down.sql')) {
      await db.execute(sql.raw(statement));
    }
    const left = await queryRows<{ name: string }>(
      db,
      sql`select column_name as name from information_schema.columns
          where (table_name = 'received_document_items' and column_name in ('removed_at', 'removed_by'))
             or (table_name = 'received_documents' and column_name in ('corrected_at', 'corrected_by'))`,
    );
    expect(left).toEqual([]);
  });
});
