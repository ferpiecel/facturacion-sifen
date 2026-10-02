import { afterEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import type { DatabaseHandle } from '../src/client.js';
import {
  documents,
  loteDocuments,
  lotes,
  tenantEstablishments,
  tenantExpeditionPoints,
  tenants,
  tenantTimbrados,
} from '../src/schema.js';
import { withTenantTransaction } from '../src/tenant-transaction.js';
import { createTestDatabase } from './support/harness.js';

async function causeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    const cause = (error as { cause?: unknown }).cause;
    return cause instanceof Error ? cause.message : String(error);
  }
  return expect.unreachable('expected the query to reject');
}

const CDC_A = '01800695631001001000000112026010111234567891';

/** Spec: HU-E6-02 (DB part). Lotes sent to SIFEN and the documents they carry, isolated by RLS. */
describe('lotes', () => {
  let handle: DatabaseHandle | undefined;

  afterEach(async () => {
    await handle?.close();
    handle = undefined;
  });

  async function seed() {
    handle = await createTestDatabase();
    const { db } = handle;
    const [a, b] = await db
      .insert(tenants)
      .values([{ name: 'A' }, { name: 'B' }])
      .returning();
    const [est] = await db
      .insert(tenantEstablishments)
      .values({
        tenantId: a.id,
        code: '001',
        address: 'Av. Mariscal Lopez 123',
        houseNumber: '123',
        departmentCode: '11',
        districtCode: '145',
        districtDescription: 'Asuncion',
        cityCode: '3432',
        cityDescription: 'Asuncion',
      })
      .returning();
    const [point] = await db
      .insert(tenantExpeditionPoints)
      .values({ tenantId: a.id, establishmentId: est.id, code: '001' })
      .returning();
    const [timbrado] = await db
      .insert(tenantTimbrados)
      .values({ tenantId: a.id, number: '12345678', validFrom: '2024-01-01' })
      .returning();
    const [document] = await db
      .insert(documents)
      .values({
        tenantId: a.id,
        environment: 'test',
        timbradoId: timbrado.id,
        establishmentId: est.id,
        expeditionPointId: point.id,
        documentType: 1,
        number: 1,
        cdc: CDC_A,
        securityCode: '123456789',
        issuedAt: new Date('2026-01-01T12:00:00Z'),
        totalAmount: '110000',
        payload: {},
      })
      .returning();
    const lote = (tenantId: string, overrides: Partial<typeof lotes.$inferInsert> = {}) => ({
      tenantId,
      environment: 'test' as const,
      documentType: 1,
      ...overrides,
    });
    return { db, a: a.id, b: b.id, documentId: document.id, lote };
  }

  it('creates a pending lote with no protocol', async () => {
    const { db, a, lote } = await seed();
    const [row] = await db.insert(lotes).values(lote(a)).returning();
    expect(row.status).toBe('pending');
    expect(row.sifenProtocol).toBeNull();
    expect(row.sentAt).toBeNull();
  });

  it('isolates lotes and lote_documents by tenant through RLS', async () => {
    const { db, a, b, documentId, lote } = await seed();
    const [row] = await db.insert(lotes).values(lote(a)).returning();
    await db.insert(loteDocuments).values({ tenantId: a, loteId: row.id, documentId });

    expect(await withTenantTransaction(db, b, (tx) => tx.select().from(lotes))).toEqual([]);
    expect(await withTenantTransaction(db, b, (tx) => tx.select().from(loteDocuments))).toEqual([]);
    const crossTenant = withTenantTransaction(db, b, (tx) => tx.insert(lotes).values(lote(a)));
    expect(await causeOf(crossTenant)).toContain('row-level security');
  });

  it('lets app_user insert and update but never delete', async () => {
    const { db, a, documentId, lote } = await seed();
    const [row] = await withTenantTransaction(db, a, (tx) =>
      tx.insert(lotes).values(lote(a)).returning(),
    );
    await withTenantTransaction(db, a, (tx) =>
      tx.insert(loteDocuments).values({ tenantId: a, loteId: row.id, documentId }),
    );
    await withTenantTransaction(db, a, (tx) =>
      tx.update(lotes).set({ status: 'sending' }).where(eq(lotes.id, row.id)),
    );
    expect(await causeOf(withTenantTransaction(db, a, (tx) => tx.delete(lotes)))).toContain(
      'permission denied for table lotes',
    );
    expect(await causeOf(withTenantTransaction(db, a, (tx) => tx.delete(loteDocuments)))).toContain(
      'permission denied for table lote_documents',
    );
  });

  it('rejects an unknown status and a document type out of range', async () => {
    const { db, a, lote } = await seed();
    expect(await causeOf(db.insert(lotes).values(lote(a, { status: 'bogus' })))).toContain(
      'lotes_status_valid',
    );
    expect(await causeOf(db.insert(lotes).values(lote(a, { documentType: 9 })))).toContain(
      'lotes_document_type_range',
    );
  });

  it('rejects an environment that differs from the tenant environment on insert', async () => {
    const { db, a, lote } = await seed();
    const message = await causeOf(db.insert(lotes).values(lote(a, { environment: 'production' })));
    expect(message).toContain('environment must match');
  });

  /** Runs the update as app_user inside the tenant's transaction (the guard must hold there). */
  const update = (
    db: DatabaseHandle['db'],
    tenantId: string,
    id: string,
    set: Partial<typeof lotes.$inferInsert>,
  ) =>
    withTenantTransaction(db, tenantId, (tx) =>
      tx.update(lotes).set(set).where(eq(lotes.id, id)).returning(),
    );

  it('makes the identity columns immutable for app_user', async () => {
    const { db, a, lote } = await seed();
    const [row] = await db.insert(lotes).values(lote(a)).returning();
    expect(await causeOf(update(db, a, row.id, { documentType: 2 }))).toContain('immutable');
    expect(await causeOf(update(db, a, row.id, { environment: 'production' }))).toContain(
      'environment must match',
    );
    expect(
      await causeOf(update(db, a, row.id, { createdAt: new Date('2020-01-01T00:00:00Z') })),
    ).toContain('immutable');
  });

  it('lets the status advance pending, sending, sent and records the write-once fields', async () => {
    const { db, a, lote } = await seed();
    const [row] = await db.insert(lotes).values(lote(a)).returning();
    await update(db, a, row.id, { status: 'sending' });
    const sentAt = new Date('2026-10-01T12:00:00Z');
    const [sent] = await update(db, a, row.id, {
      status: 'sent',
      sifenProtocol: '4500123',
      sentAt,
    });
    expect(sent).toMatchObject({ status: 'sent', sifenProtocol: '4500123', sentAt });
  });

  it.each([
    ['pending', 'sent'],
    ['pending', 'rejected'],
    ['sending', 'pending'],
    ['sent', 'pending'],
    ['sent', 'sending'],
    ['sent', 'rejected'],
    ['sent', 'unknown'],
    ['rejected', 'sent'],
    ['rejected', 'pending'],
    ['unknown', 'pending'],
    ['unknown', 'sending'],
  ])('rejects the transition %s -> %s', async (from, to) => {
    const { db, a, lote } = await seed();
    const [row] = await db
      .insert(lotes)
      .values(lote(a, { status: from }))
      .returning();
    expect(await causeOf(update(db, a, row.id, { status: to }))).toContain(
      'invalid status transition',
    );
  });

  it.each([
    ['pending', 'sending'],
    ['sending', 'sent'],
    ['sending', 'rejected'],
    ['sending', 'unknown'],
    ['unknown', 'sent'],
    ['unknown', 'rejected'],
  ])('allows the transition %s -> %s', async (from, to) => {
    const { db, a, lote } = await seed();
    const [row] = await db
      .insert(lotes)
      .values(lote(a, { status: from }))
      .returning();
    const [updated] = await update(db, a, row.id, { status: to });
    expect(updated.status).toBe(to);
  });

  it('allows updating other columns without changing the status', async () => {
    const { db, a, lote } = await seed();
    const [row] = await db
      .insert(lotes)
      .values(lote(a, { status: 'sent' }))
      .returning();
    const [updated] = await update(db, a, row.id, { responseMessage: 'note' });
    expect(updated.responseMessage).toBe('note');
  });

  it('makes sent_at and sifen_protocol write-once', async () => {
    const { db, a, lote } = await seed();
    const [row] = await db
      .insert(lotes)
      .values(lote(a, { status: 'sent', sifenProtocol: '4500123', sentAt: new Date('2026-10-01') }))
      .returning();
    expect(await causeOf(update(db, a, row.id, { sifenProtocol: '999' }))).toContain('write-once');
    expect(await causeOf(update(db, a, row.id, { sentAt: new Date('2026-10-02') }))).toContain(
      'write-once',
    );
    expect(await causeOf(update(db, a, row.id, { sifenProtocol: null }))).toContain('write-once');
  });

  it('indexes lote_documents by document_id', async () => {
    const { db } = await seed();
    const result = await db.execute(
      sql`select 1 from pg_indexes where tablename = 'lote_documents' and indexdef like '%(document_id)%'`,
    );
    expect(result.rows).toHaveLength(1);
  });

  it('links a document to a lote once, and only within the same tenant', async () => {
    const { db, a, b, documentId, lote } = await seed();
    const [row] = await db.insert(lotes).values(lote(a)).returning();
    await db.insert(loteDocuments).values({ tenantId: a, loteId: row.id, documentId });
    expect(
      await causeOf(db.insert(loteDocuments).values({ tenantId: a, loteId: row.id, documentId })),
    ).toContain('lote_documents_lote_id_document_id_pk');
    expect(
      await causeOf(
        db.insert(loteDocuments).values({ tenantId: b, loteId: crypto.randomUUID(), documentId }),
      ),
    ).toContain('lote_documents_tenant_lote_fk');
  });
});
