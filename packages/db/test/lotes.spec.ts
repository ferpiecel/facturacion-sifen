import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
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

  it('makes the identity columns immutable but lets the state advance', async () => {
    const { db, a, lote } = await seed();
    await db.insert(lotes).values(lote(a));
    expect(await causeOf(db.update(lotes).set({ documentType: 2 }))).toContain('immutable');
    expect(await causeOf(db.update(lotes).set({ environment: 'production' }))).toContain(
      'immutable',
    );
    const [row] = await db
      .update(lotes)
      .set({ status: 'sent', sifenProtocol: '4500123' })
      .returning();
    expect(row.sifenProtocol).toBe('4500123');
  });

  it('links a document to a lote once, and only within the same tenant', async () => {
    const { db, a, b, documentId, lote } = await seed();
    const [row] = await db.insert(lotes).values(lote(a)).returning();
    await db.insert(loteDocuments).values({ tenantId: a, loteId: row.id, documentId });
    expect(
      await causeOf(db.insert(loteDocuments).values({ tenantId: a, loteId: row.id, documentId })),
    ).toContain('lote_documents_pkey');
    expect(
      await causeOf(db.insert(loteDocuments).values({ tenantId: b, loteId: row.id, documentId })),
    ).toContain('lote_documents_tenant_lote_fk');
  });
});
