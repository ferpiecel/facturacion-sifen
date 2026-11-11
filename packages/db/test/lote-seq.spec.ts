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
import { createTestDatabase } from './support/harness.js';

const CDC = '01800695631001001000000112026010111234567891';

/** Spec: hardening E6 (ADR-0007/0008). Lote order and resend ownership come from sequences, not the clock. */
describe('lote sequence', () => {
  let handle: DatabaseHandle | undefined;

  afterEach(async () => {
    await handle?.close();
    handle = undefined;
  });

  async function seed() {
    handle = await createTestDatabase();
    const { db } = handle;
    const [tenant] = await db.insert(tenants).values({ name: 'A' }).returning();
    const [est] = await db
      .insert(tenantEstablishments)
      .values({
        tenantId: tenant.id,
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
      .values({ tenantId: tenant.id, establishmentId: est.id, code: '001' })
      .returning();
    const [timbrado] = await db
      .insert(tenantTimbrados)
      .values({ tenantId: tenant.id, number: '12345678', validFrom: '2024-01-01' })
      .returning();
    const [doc] = await db
      .insert(documents)
      .values({
        tenantId: tenant.id,
        environment: 'test',
        timbradoId: timbrado.id,
        establishmentId: est.id,
        expeditionPointId: point.id,
        documentType: 1,
        number: 1,
        cdc: CDC,
        securityCode: '123456789',
        status: 'submitted',
        issuedAt: new Date(),
        totalAmount: '110000',
        payload: {},
      })
      .returning();
    const addLote = async (status: string, createdAt?: Date) => {
      const [lote] = await db
        .insert(lotes)
        .values({ tenantId: tenant.id, environment: 'test', documentType: 1, status, createdAt })
        .returning();
      return lote;
    };
    return { db, tenant, doc, addLote };
  }

  it('numbers lotes in creation order whatever created_at says', async () => {
    const { addLote } = await seed();
    const first = await addLote('pending', new Date('2030-01-01T00:00:00Z'));
    const second = await addLote('pending', new Date('2000-01-01T00:00:00Z'));
    expect(second.seq).toBeGreaterThan(first.seq);
  });

  it('refuses to set seq by hand', async () => {
    const { db, tenant } = await seed();
    await expect(
      db.execute(
        sql`insert into lotes (tenant_id, environment, document_type, seq) values (${tenant.id}, 'test', 1, 5)`,
      ),
    ).rejects.toThrow();
  });

  it('stamps the resend watermark with the newest lote carrying the document, once', async () => {
    const { db, tenant, doc, addLote } = await seed();
    const older = await addLote('processed');
    const newer = await addLote('recovery');
    await db.insert(loteDocuments).values([
      { tenantId: tenant.id, loteId: older.id, documentId: doc.id },
      { tenantId: tenant.id, loteId: newer.id, documentId: doc.id },
    ]);
    expect(doc.resentAfterSeq).toBeNull();
    await db
      .update(documents)
      .set({ status: 'queued', resentAt: new Date(), transmissionAttempts: 1 })
      .where(eq(documents.id, doc.id));
    const [stamped] = await db.select().from(documents).where(eq(documents.id, doc.id));
    expect(stamped.resentAfterSeq).toBe(newer.seq);
    // Not movable, not even by an explicit write.
    await db.update(documents).set({ resentAfterSeq: 0 }).where(eq(documents.id, doc.id));
    const [after] = await db.select().from(documents).where(eq(documents.id, doc.id));
    expect(after.resentAfterSeq).toBe(newer.seq);
  });
});
