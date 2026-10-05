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

/** Spec: HU-E6-02 (S5f, DB part). Per-document retry state of the transmission pipeline. */
describe('documents transmission retry state', () => {
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
    const [document] = await db
      .insert(documents)
      .values({
        tenantId: tenant.id,
        environment: 'test',
        timbradoId: timbrado.id,
        establishmentId: est.id,
        expeditionPointId: point.id,
        documentType: 1,
        number: 1,
        cdc: '01800695631001001000000112026010111234567891',
        securityCode: '123456789',
        issuedAt: new Date('2026-01-01T12:00:00Z'),
        totalAmount: '110000',
        payload: {},
      })
      .returning();
    return { db, document };
  }

  it('starts with no attempts, no backoff and no hold', async () => {
    const { document } = await seed();
    expect(document).toMatchObject({
      transmissionAttempts: 0,
      nextTransmissionAt: null,
      transmissionHold: null,
    });
  });

  it('lets the pipeline update the retry state without touching the identity guard', async () => {
    const { db, document } = await seed();
    const next = new Date('2026-10-02T12:05:00Z');
    await db
      .update(documents)
      .set({ transmissionAttempts: 2, nextTransmissionAt: next, transmissionHold: 'signing:X' })
      .where(eq(documents.id, document.id));
    const [row] = await db.select().from(documents).where(eq(documents.id, document.id));
    expect(row).toMatchObject({
      transmissionAttempts: 2,
      nextTransmissionAt: next,
      transmissionHold: 'signing:X',
    });
    // The identity guard of 0024/0025 is intact.
    const cdc = db
      .update(documents)
      .set({ cdc: '9'.repeat(44) })
      .where(eq(documents.id, document.id));
    expect(await causeOf(cdc)).toContain('identity columns are immutable');
  });

  it('rejects a negative attempt count and a hold that is empty, long or not a plain code', async () => {
    const { db, document } = await seed();
    const set = (values: Partial<typeof documents.$inferInsert>) =>
      db.update(documents).set(values).where(eq(documents.id, document.id));
    expect(await causeOf(set({ transmissionAttempts: -1 }))).toContain(
      'documents_transmission_attempts_range',
    );
    expect(await causeOf(set({ transmissionHold: 'x'.repeat(65) }))).toContain('too long');
    for (const hold of ['', 'has space', 'p12 password hunter2']) {
      expect(await causeOf(set({ transmissionHold: hold }))).toContain(
        'documents_transmission_hold_format',
      );
    }
  });
});
