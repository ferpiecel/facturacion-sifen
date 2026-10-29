import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { fileURLToPath } from 'node:url';
import type { DatabaseHandle } from '../src/client.js';
import {
  documentCorrectionClaims,
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

  /** The history row the door requires to exist before the rewrite (same transaction in production). */
  async function recordHistory(
    { db, a, row }: Awaited<ReturnType<typeof seed>>,
    idempotencyKey = 'hist-1',
  ) {
    await db.insert(documentCorrections).values({
      tenantId: a,
      documentId: row.id,
      kind: 'same_cdc',
      idempotencyKey,
      requestHash: HASH,
      previousPayload: row.payload,
    });
  }

  describe('documents_guard door', () => {
    it('rewrites a rejected document to accepted with the correction counted, keeping its CDC', async () => {
      const seeded = await seed();
      const { db, row } = seeded;
      await recordHistory(seeded);
      const [after] = await db
        .update(documents)
        .set(door)
        .where(eq(documents.id, row.id))
        .returning();
      expect(after).toMatchObject({ status: 'accepted', correctionsCount: 1, cdc: CDC_A });
      expect(after.payload).toEqual({ items: [{ q: 1 }] });
    });

    it('requires the signed XML to be cleared in the same step', async () => {
      const seeded = await seed({
        signedXml: '<DE/>',
        signedAt: new Date('2026-01-01T12:01:00Z'),
      });
      const { db, row } = seeded;
      await recordHistory(seeded);
      const update = (set: object) => db.update(documents).set(set).where(eq(documents.id, row.id));
      expect(await causeOf(update(door))).toContain('signed again');
      await update({ ...door, signedXml: null, signedAt: null });
    });

    it('refuses the door without its history row', async () => {
      const { db, row } = await seed();
      const result = db.update(documents).set(door).where(eq(documents.id, row.id));
      expect(await causeOf(result)).toContain('recorded in document_corrections first');
    });

    it('refuses to correct a document that is not rejected', async () => {
      const { db, row } = await seed({ status: 'approved', sifenMessages: null });
      const result = db.update(documents).set(door).where(eq(documents.id, row.id));
      expect(await causeOf(result)).toContain('documents:');
    });

    it('refuses the door when the correction is not counted exactly once', async () => {
      const seeded = await seed();
      const { db, row } = seeded;
      await recordHistory(seeded);
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
      const seeded = await seed();
      const { db, row } = seeded;
      await recordHistory(seeded);
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

  describe('document_correction_claims', () => {
    it('holds at most one claim per document, released by deleting it', async () => {
      const { db, a, row } = await seed();
      const claim = (key: string) =>
        db
          .insert(documentCorrectionClaims)
          .values({ tenantId: a, documentId: row.id, idempotencyKey: key, requestHash: HASH })
          .returning();
      const [first] = await claim('key-1');
      expect(await causeOf(claim('key-2'))).toContain('document_correction_claims_document_key');
      await db.delete(documentCorrectionClaims).where(eq(documentCorrectionClaims.id, first.id));
      await expect(claim('key-2')).resolves.toHaveLength(1);
    });
  });
});

/** Applies the manual rollback of 0069 statement by statement (the driver runs one statement per call). */
describe('0069 rollback', () => {
  it('leaves documents writable once the guard of 0034 is back', async () => {
    const handle = await createTestDatabase();
    try {
      const file = fileURLToPath(
        new URL('../migrations/rollback/0069_documents_corrections.down.sql', import.meta.url),
      );
      const text = readFileSync(file, 'utf8');
      const end = text.indexOf('\n$$;') + '\n$$;'.length;
      const fn = text.slice(text.indexOf('CREATE OR REPLACE FUNCTION'), end);
      const rest = text
        .slice(end)
        .split(';\n')
        .map((statement) => statement.trim())
        .filter((statement) => statement !== '');
      for (const statement of [fn, ...rest]) await handle.db.execute(sql.raw(statement));

      const [tenant] = await handle.db.insert(tenants).values({ name: 'A' }).returning();
      const [est] = await handle.db
        .insert(tenantEstablishments)
        .values({ tenantId: tenant.id, code: '001', ...ADDRESS })
        .returning();
      const [point] = await handle.db
        .insert(tenantExpeditionPoints)
        .values({ tenantId: tenant.id, establishmentId: est.id, code: '001' })
        .returning();
      const [timbrado] = await handle.db
        .insert(tenantTimbrados)
        .values({ tenantId: tenant.id, number: '12345678', validFrom: '2024-01-01' })
        .returning();
      // Raw SQL: the Drizzle schema already lists the column the rollback dropped.
      await handle.db.execute(sql`
        INSERT INTO documents (tenant_id, environment, cdc, document_type, timbrado_id, establishment_id,
          expedition_point_id, number, security_code, issued_at, total_amount, payload)
        VALUES (${tenant.id}, 'test', ${CDC_A}, 1, ${timbrado.id}, ${est.id}, ${point.id}, 1, '123456789',
          now(), '110000', '{}'::jsonb)`);
      await handle.db.execute(sql`UPDATE documents SET status = 'queued' WHERE cdc = ${CDC_A}`);
    } finally {
      await handle.close();
    }
  });
});
