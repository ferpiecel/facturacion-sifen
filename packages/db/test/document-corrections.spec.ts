import { afterEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import type { DatabaseHandle } from '../src/client.js';
import {
  documentCorrections,
  documents,
  tenantEstablishments,
  tenantExpeditionPoints,
  tenants,
  tenantTimbrados,
} from '../src/schema.js';
import { createTestDatabase } from './support/harness.js';
import { causeOf } from './support/issuer-events-fixture.js';

const CDC_A = '01800695631001001000000112026010111234567891';
const CDC_B = '01800695631001001000000212026010111234567892';
const HASH = 'a'.repeat(64);
const ADDRESS = {
  address: 'Av. Mariscal Lopez 123',
  houseNumber: '123',
  departmentCode: '11',
  districtCode: '145',
  districtDescription: 'Asuncion',
  cityCode: '3432',
  cityDescription: 'Asuncion',
};
/** What the correction writes: the one `rejected -> accepted` step the guard allows (ADR-0021). */
const door = {
  status: 'accepted',
  correctionsCount: 1,
  payload: { items: [{ q: 1 }] },
  totalAmount: '220000',
  sifenMessages: null,
} as const;

/** Spec: HU-E8-01 (DB part, ADR-0021). The door that rewrites a rejected document, and its correction history. */
describe('document corrections', () => {
  let handle: DatabaseHandle | undefined;

  afterEach(async () => {
    await handle?.close();
    handle = undefined;
  });

  async function seed(overrides: Partial<typeof documents.$inferInsert> = {}) {
    handle = await createTestDatabase();
    const { db } = handle;
    const [a] = await db.insert(tenants).values({ name: 'A' }).returning();
    const [est] = await db
      .insert(tenantEstablishments)
      .values({ tenantId: a.id, code: '001', ...ADDRESS })
      .returning();
    const [point] = await db
      .insert(tenantExpeditionPoints)
      .values({ tenantId: a.id, establishmentId: est.id, code: '001' })
      .returning();
    const [timbrado] = await db
      .insert(tenantTimbrados)
      .values({ tenantId: a.id, number: '12345678', validFrom: '2024-01-01' })
      .returning();
    const values = () => ({
      tenantId: a.id,
      environment: 'test' as const,
      timbradoId: timbrado.id,
      establishmentId: est.id,
      expeditionPointId: point.id,
      documentType: 1,
      number: 1,
      cdc: CDC_A,
      securityCode: '123456789',
      issuedAt: new Date('2026-01-01T12:00:00Z'),
      totalAmount: '110000',
      payload: { items: [] },
      status: 'rejected',
      sifenMessages: [{ code: '1000', message: 'x' }],
      ...overrides,
    });
    const [row] = await db.insert(documents).values(values()).returning();
    return { db, a: a.id, row };
  }

  describe('documents_guard door', () => {
    it('rewrites a rejected document to accepted with the correction counted, keeping its CDC', async () => {
      const { db, row } = await seed();
      const [after] = await db
        .update(documents)
        .set(door)
        .where(eq(documents.id, row.id))
        .returning();
      expect(after).toMatchObject({ status: 'accepted', correctionsCount: 1, cdc: CDC_A });
      expect(after.payload).toEqual({ items: [{ q: 1 }] });
    });

    it('requires the signed XML to be cleared in the same step', async () => {
      const { db, row } = await seed({
        signedXml: '<DE/>',
        signedAt: new Date('2026-01-01T12:01:00Z'),
      });
      const update = (set: object) => db.update(documents).set(set).where(eq(documents.id, row.id));
      expect(await causeOf(update(door))).toContain('signed again');
      await update({ ...door, signedXml: null, signedAt: null });
    });

    it('refuses to correct a document that is not rejected', async () => {
      const { db, row } = await seed({ status: 'approved', sifenMessages: null });
      const result = db.update(documents).set(door).where(eq(documents.id, row.id));
      expect(await causeOf(result)).toContain('documents:');
    });

    it('refuses the door when the correction is not counted exactly once', async () => {
      const { db, row } = await seed();
      const update = (correctionsCount: number) =>
        db
          .update(documents)
          .set({ ...door, correctionsCount })
          .where(eq(documents.id, row.id));
      expect(await causeOf(update(2))).toContain('corrections_count');
    });

    it('refuses to move the count outside the door', async () => {
      const { db, row } = await seed({ status: 'accepted', sifenMessages: null });
      const bump = db
        .update(documents)
        .set({ correctionsCount: 1 })
        .where(eq(documents.id, row.id));
      expect(await causeOf(bump)).toContain('corrections_count');
    });

    it.each([
      ['cdc', { cdc: CDC_B }],
      ['associated cdc', { associatedCdc: CDC_B }],
    ])('keeps %s immutable through the door', async (_label, change) => {
      const { db, row } = await seed();
      const result = db
        .update(documents)
        .set({ ...door, ...change })
        .where(eq(documents.id, row.id));
      expect(await causeOf(result)).toContain('immutable');
    });
  });

  describe('document_corrections', () => {
    it('requires a replacement exactly for a reissue and is append-only', async () => {
      const { db, a, row } = await seed();
      const base = {
        tenantId: a,
        documentId: row.id,
        idempotencyKey: 'key-1',
        requestHash: HASH,
        previousPayload: { items: [] },
      };
      const bare = db.insert(documentCorrections).values({ ...base, kind: 'reissue' });
      expect(await causeOf(bare)).toContain('document_corrections_replacement');
      const [stored] = await db
        .insert(documentCorrections)
        .values({ ...base, kind: 'same_cdc' })
        .returning();
      const update = db
        .update(documentCorrections)
        .set({ requestHash: 'b'.repeat(64) })
        .where(eq(documentCorrections.id, stored.id));
      expect(await causeOf(update)).toContain('append-only');
      const remove = db.execute(sql`DELETE FROM document_corrections WHERE id = ${stored.id}`);
      expect(await causeOf(remove)).toContain('append-only');
    });
  });
});
