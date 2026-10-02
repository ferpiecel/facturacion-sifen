import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { DatabaseHandle } from '../src/client.js';
import {
  documents,
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
const CDC_B = '01800695631001001000000212026010111234567892';

/** Spec: HU-E5-01 (DB part). Accepted fiscal documents, isolated per tenant by RLS. */
describe('documents', () => {
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

    async function fiscalSetup(tenantId: string) {
      const [est] = await db
        .insert(tenantEstablishments)
        .values({
          tenantId,
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
        .values({ tenantId, establishmentId: est.id, code: '001' })
        .returning();
      const [timbrado] = await db
        .insert(tenantTimbrados)
        .values({ tenantId, number: '12345678', validFrom: '2024-01-01' })
        .returning();
      return { timbradoId: timbrado.id, establishmentId: est.id, expeditionPointId: point.id };
    }

    const setupA = await fiscalSetup(a.id);
    const setupB = await fiscalSetup(b.id);
    const doc = (
      tenantId: string,
      setup: typeof setupA,
      overrides: Partial<typeof documents.$inferInsert> = {},
    ): typeof documents.$inferInsert => ({
      tenantId,
      environment: 'test',
      ...setup,
      documentType: 1,
      number: 1,
      cdc: CDC_A,
      securityCode: '123456789',
      issuedAt: new Date('2026-01-01T12:00:00Z'),
      totalAmount: '110000',
      payload: { items: [] },
      ...overrides,
    });
    return { db, a: a.id, b: b.id, setupA, setupB, doc };
  }

  it('stores a document as accepted with an empty series by default', async () => {
    const { db, a, setupA, doc } = await seed();
    const [row] = await db.insert(documents).values(doc(a, setupA)).returning();
    expect(row.status).toBe('accepted');
    expect(row.series).toBe('');
    expect(row.currency).toBe('PYG');
    expect(row.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('isolates reads and writes by tenant through RLS', async () => {
    const { db, a, b, setupA, setupB, doc } = await seed();
    await db.insert(documents).values(doc(a, setupA));
    await db.insert(documents).values(doc(b, setupB, { cdc: CDC_B }));

    const seen = await withTenantTransaction(db, a, (tx) => tx.select().from(documents));
    expect(seen.map((r) => r.tenantId)).toEqual([a]);

    const crossTenant = withTenantTransaction(db, a, (tx) =>
      tx.insert(documents).values(doc(b, setupB, { cdc: CDC_B, number: 2 })),
    );
    expect(await causeOf(crossTenant)).toContain('row-level security');
  });

  it('lets app_user insert and update but never delete', async () => {
    const { db, a, setupA, doc } = await seed();
    await withTenantTransaction(db, a, (tx) => tx.insert(documents).values(doc(a, setupA)));
    await withTenantTransaction(db, a, (tx) =>
      tx.update(documents).set({ status: 'signed' }).where(eq(documents.cdc, CDC_A)),
    );
    expect(await causeOf(withTenantTransaction(db, a, (tx) => tx.delete(documents)))).toContain(
      'permission denied for table documents',
    );
  });

  it('rejects a duplicate CDC and a duplicate number in the same sequence', async () => {
    const { db, a, setupA, doc } = await seed();
    await db.insert(documents).values(doc(a, setupA));
    expect(await causeOf(db.insert(documents).values(doc(a, setupA, { number: 2 })))).toContain(
      'documents_tenant_environment_cdc_key',
    );
    expect(await causeOf(db.insert(documents).values(doc(a, setupA, { cdc: CDC_B })))).toContain(
      'documents_sequence_number_key',
    );
  });

  it('rejects malformed identity values', async () => {
    const { db, a, setupA, doc } = await seed();
    const bad: [Partial<typeof documents.$inferInsert>, string][] = [
      [{ cdc: '123' }, 'documents_cdc_format'],
      [{ securityCode: '12345678A' }, 'documents_security_code_format'],
      [{ number: 10_000_000 }, 'documents_number_range'],
      [{ documentType: 9 }, 'documents_document_type_range'],
      [{ series: 'ÑA' }, 'documents_series_format'],
      [{ status: 'bogus' }, 'documents_status_valid'],
    ];
    for (const [overrides, constraint] of bad) {
      expect(await causeOf(db.insert(documents).values(doc(a, setupA, overrides)))).toContain(
        constraint,
      );
    }
  });

  it('makes the identity columns immutable but lets the status advance', async () => {
    const { db, a, setupA, doc } = await seed();
    await db.insert(documents).values(doc(a, setupA));
    expect(await causeOf(db.update(documents).set({ cdc: CDC_B }))).toContain('immutable');
    expect(await causeOf(db.update(documents).set({ number: 2 }))).toContain('immutable');
    expect(await causeOf(db.update(documents).set({ payload: { items: [1] } }))).toContain(
      'immutable',
    );
    const [row] = await db.update(documents).set({ status: 'signed' }).returning();
    expect(row.status).toBe('signed');
  });
});
