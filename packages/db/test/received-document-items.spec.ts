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

type ItemInsert = typeof receivedDocumentItems.$inferInsert;
type ConfidenceInsert = typeof receivedDocumentFieldConfidences.$inferInsert;

/** Spec: reception R1.4. Line items and per-field confidences of a received document. */
describe('received_document_items and received_document_field_confidences', () => {
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
    const [docA, docB] = await handle.db
      .insert(receivedDocuments)
      .values([
        { tenantId: a, source: 'sifen_xml' },
        { tenantId: b, source: 'sifen_xml' },
      ])
      .returning();
    return { db: handle.db, a, b, docA: docA.id, docB: docB.id };
  }

  const item = (
    tenantId: string,
    docId: string,
    overrides: Partial<ItemInsert> = {},
  ): ItemInsert => ({
    tenantId,
    receivedDocumentId: docId,
    position: 1,
    ...overrides,
  });

  const confidence = (
    tenantId: string,
    docId: string,
    overrides: Partial<ConfidenceInsert> = {},
  ): ConfidenceInsert => ({
    tenantId,
    receivedDocumentId: docId,
    fieldName: 'issuer_ruc',
    confidence: '0.900',
    ...overrides,
  });

  describe('items', () => {
    it('stores an item with exact decimals (quantity numeric(18,8), money numeric(23,8))', async () => {
      const { db, a, docA } = await seed();
      const [row] = await db
        .insert(receivedDocumentItems)
        .values(
          item(a, docA, {
            description: 'Cafe',
            productCode: 'P-1',
            unitOfMeasure: 'UNI',
            quantity: '1234567890.12345678',
            unitPrice: '123456789012345.12345678',
            discount: '0.00000001',
            subtotal: '0.00000002',
            vatRate: 10,
            taxableBase: '0.00000003',
            vatAmount: '0.00000004',
          }),
        )
        .returning();
      expect(row).toMatchObject({
        quantity: '1234567890.12345678',
        unitPrice: '123456789012345.12345678',
        discount: '0.00000001',
        subtotal: '0.00000002',
        taxableBase: '0.00000003',
        vatAmount: '0.00000004',
        vatRate: 10,
      });
      expect(row.createdAt).toBeInstanceOf(Date);
    });

    it('refuses a quantity beyond 10 integer digits', async () => {
      const { db, a, docA } = await seed();
      expect(
        await causeOf(
          db.insert(receivedDocumentItems).values(item(a, docA, { quantity: '12345678901' })),
        ),
      ).toContain('numeric field overflow');
    });

    it('enforces position >= 1 and a VAT rate of 0, 5 or 10', async () => {
      const { db, a, docA } = await seed();
      expect(
        await causeOf(db.insert(receivedDocumentItems).values(item(a, docA, { position: 0 }))),
      ).toContain('received_document_items_position_positive');
      expect(
        await causeOf(db.insert(receivedDocumentItems).values(item(a, docA, { vatRate: 7 }))),
      ).toContain('received_document_items_vat_rate_valid');
      for (const [i, vatRate] of [0, 5, 10].entries()) {
        await db.insert(receivedDocumentItems).values(item(a, docA, { position: i + 1, vatRate }));
      }
    });

    it('keeps positions unique within a document', async () => {
      const { db, a, docA } = await seed();
      await db.insert(receivedDocumentItems).values(item(a, docA));
      expect(await causeOf(db.insert(receivedDocumentItems).values(item(a, docA)))).toContain(
        'received_document_items_document_position_key',
      );
      await db.insert(receivedDocumentItems).values(item(a, docA, { position: 2 }));
    });

    it('references a document only of the same tenant (composite foreign key)', async () => {
      const { db, a, docB } = await seed();
      expect(await causeOf(db.insert(receivedDocumentItems).values(item(a, docB)))).toContain(
        'received_document_items_document_fk',
      );
    });
  });

  describe('field confidences', () => {
    it('stores a confidence and its correction audit', async () => {
      const { db, a, docA } = await seed();
      const when = new Date('2026-11-06T12:00:00Z');
      const [row] = await db
        .insert(receivedDocumentFieldConfidences)
        .values(
          confidence(a, docA, {
            extractedValue: '80069563-1',
            correctedValue: '80069563-0',
            correctedBy: 'key-1',
            correctedAt: when,
          }),
        )
        .returning();
      expect(row).toMatchObject({ confidence: '0.900', correctedBy: 'key-1', correctedAt: when });
    });

    it('accepts exactly the 8 curated field names', async () => {
      const { db, a, docA } = await seed();
      const names = [
        'issuer_ruc',
        'issuer_legal_name',
        'issued_on',
        'document_number',
        'receiver_ruc',
        'payment_condition',
        'totals',
        'items',
      ];
      await db
        .insert(receivedDocumentFieldConfidences)
        .values(names.map((fieldName) => confidence(a, docA, { fieldName })));
      expect(
        await causeOf(
          db
            .insert(receivedDocumentFieldConfidences)
            .values(confidence(a, docA, { fieldName: 'currency' })),
        ),
      ).toContain('received_document_field_confidences_field_name_valid');
    });

    it('keeps the confidence within 0..1', async () => {
      const { db, a, docA } = await seed();
      for (const value of ['1.001', '-0.001']) {
        expect(
          await causeOf(
            db
              .insert(receivedDocumentFieldConfidences)
              .values(confidence(a, docA, { confidence: value })),
          ),
        ).toContain('received_document_field_confidences_confidence_range');
      }
      await db
        .insert(receivedDocumentFieldConfidences)
        .values([
          confidence(a, docA, { fieldName: 'items', confidence: '0.000' }),
          confidence(a, docA, { fieldName: 'totals', confidence: '1.000' }),
        ]);
    });

    it('sets corrected_by and corrected_at together or not at all', async () => {
      const { db, a, docA } = await seed();
      for (const overrides of [{ correctedBy: 'key-1' }, { correctedAt: new Date() }]) {
        expect(
          await causeOf(
            db.insert(receivedDocumentFieldConfidences).values(confidence(a, docA, overrides)),
          ),
        ).toContain('received_document_field_confidences_correction_pair');
      }
    });

    it('keeps one confidence per field and document', async () => {
      const { db, a, docA, b, docB } = await seed();
      await db.insert(receivedDocumentFieldConfidences).values(confidence(a, docA));
      expect(
        await causeOf(db.insert(receivedDocumentFieldConfidences).values(confidence(a, docA))),
      ).toContain('received_document_field_confidences_document_field_key');
      await db.insert(receivedDocumentFieldConfidences).values(confidence(b, docB));
    });

    it('references a document only of the same tenant (composite foreign key)', async () => {
      const { db, a, docB } = await seed();
      expect(
        await causeOf(db.insert(receivedDocumentFieldConfidences).values(confidence(a, docB))),
      ).toContain('received_document_field_confidences_document_fk');
    });
  });

  it('isolates by tenant: reads, cross-tenant inserts and cross-tenant updates are blocked', async () => {
    const { db, a, b, docA, docB } = await seed();
    await db.insert(receivedDocumentItems).values([item(a, docA), item(b, docB)]);
    await db
      .insert(receivedDocumentFieldConfidences)
      .values([confidence(a, docA), confidence(b, docB)]);

    const itemsSeenByA = await withTenantTransaction(db, a, (tx) =>
      tx.select().from(receivedDocumentItems),
    );
    expect(itemsSeenByA.map((row) => row.tenantId)).toEqual([a]);
    const confidencesSeenByA = await withTenantTransaction(db, a, (tx) =>
      tx.select().from(receivedDocumentFieldConfidences),
    );
    expect(confidencesSeenByA.map((row) => row.tenantId)).toEqual([a]);

    for (const insert of [
      (tx: Parameters<Parameters<typeof withTenantTransaction>[2]>[0]) =>
        tx.insert(receivedDocumentItems).values(item(a, docA, { position: 2 })),
      (tx: Parameters<Parameters<typeof withTenantTransaction>[2]>[0]) =>
        tx
          .insert(receivedDocumentFieldConfidences)
          .values(confidence(a, docA, { fieldName: 'items' })),
    ]) {
      expect(await causeOf(withTenantTransaction(db, b, insert))).toContain('row-level security');
    }

    await withTenantTransaction(db, b, (tx) =>
      tx.update(receivedDocumentItems).set({ description: 'hijacked' }),
    );
    await withTenantTransaction(db, b, (tx) =>
      tx.update(receivedDocumentFieldConfidences).set({ extractedValue: 'hijacked' }),
    );
    const items = await db.select().from(receivedDocumentItems);
    expect(items.find((row) => row.tenantId === a)?.description).toBeNull();
    expect(items.find((row) => row.tenantId === b)?.description).toBe('hijacked');
    const confidences = await db
      .select()
      .from(receivedDocumentFieldConfidences)
      .where(eq(receivedDocumentFieldConfidences.tenantId, a));
    expect(confidences[0].extractedValue).toBeNull();
  });

  it('gives app_user no way to delete, and partner_viewer no access at all', async () => {
    const { db, a, docA } = await seed();
    await db.insert(receivedDocumentItems).values(item(a, docA));
    await db.insert(receivedDocumentFieldConfidences).values(confidence(a, docA));
    expect(
      await causeOf(withTenantTransaction(db, a, (tx) => tx.delete(receivedDocumentItems))),
    ).toContain('permission denied for table received_document_items');
    expect(
      await causeOf(
        withTenantTransaction(db, a, (tx) => tx.delete(receivedDocumentFieldConfidences)),
      ),
    ).toContain('permission denied for table received_document_field_confidences');
    const grants = await queryRows<{ grantee: string }>(
      db,
      sql`select distinct grantee from information_schema.role_table_grants
          where table_name in ('received_document_items', 'received_document_field_confidences')
            and grantee = 'partner_viewer'`,
    );
    expect(grants).toEqual([]);
  });

  it('rolls back cleanly: RLS first (0051), then the tables (0050)', async () => {
    const { db } = await seed();
    for (const file of [
      '0051_received_document_items_and_confidences_rls.down.sql',
      '0050_received_document_items_and_confidences.down.sql',
    ]) {
      for (const statement of rollbackStatements(file)) {
        await db.execute(sql.raw(statement));
      }
    }
    const left = await queryRows<{ relname: string }>(
      db,
      sql`select relname from pg_class
          where relname like 'received_document_item%' or relname like 'received_document_field%'`,
    );
    expect(left).toEqual([]);
  });
});
