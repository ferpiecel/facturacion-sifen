import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  createPgliteDatabase,
  documents,
  loteDocuments,
  lotes,
  tenantEstablishments,
  tenantExpeditionPoints,
  tenants,
  tenantTimbrados,
  webhookDeliveries,
  withTenantTransaction,
  type DatabaseHandle,
} from '@sifen/db';
import { seedWebhookEndpoint } from '../../../../test/support/document-seed.js';
import { createDrizzleResendPreflightStore } from './drizzle-resend-preflight-store.js';

const CDC = '01800695631001001000000112026010111234567891';
const RESOLUTION = {
  cdc: CDC,
  status: 'approved' as const,
  messages: [{ code: '0422', message: 'CDC encontrado' }],
};

/** Spec: HU-E6-04. The store behind the pre-send check of a document the recovery queued again. */
describe('DrizzleResendPreflightStore', () => {
  let handle: DatabaseHandle;
  let tenantId: string;
  let otherTenantId: string;
  let fiscal: { timbradoId: string; establishmentId: string; expeditionPointId: string };
  let counter = 0;

  beforeEach(async () => {
    counter = 0;
    handle = createPgliteDatabase();
    await handle.migrate();
    const { db } = handle;
    const [a, b] = await db
      .insert(tenants)
      .values([{ name: 'A' }, { name: 'B' }])
      .returning();
    tenantId = a.id;
    otherTenantId = b.id;
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
    fiscal = { timbradoId: timbrado.id, establishmentId: est.id, expeditionPointId: point.id };
  });

  afterEach(async () => {
    await handle.close();
  });

  const storeFor = (tenant: string) =>
    createDrizzleResendPreflightStore({
      db: handle.db,
      tenantId: tenant,
      now: () => new Date('2026-10-05T13:00:00Z'),
    });

  async function addDocument(overrides: Partial<typeof documents.$inferInsert> = {}) {
    counter += 1;
    const [row] = await handle.db
      .insert(documents)
      .values({
        tenantId,
        environment: 'test',
        ...fiscal,
        documentType: 1,
        number: counter,
        cdc: CDC,
        securityCode: '123456789',
        status: 'queued',
        resentAt: new Date('2026-10-05T12:00:00Z'),
        issuedAt: new Date('2026-01-01T12:00:00Z'),
        totalAmount: '110000',
        payload: {},
        ...overrides,
      })
      .returning();
    return row;
  }
  const readDoc = () =>
    withTenantTransaction(handle.db, tenantId, (tx) =>
      tx.select().from(documents).where(eq(documents.cdc, CDC)),
    ).then((rows) => rows[0]);

  it('approves a queued, resent document through submitted, with both events', async () => {
    await seedWebhookEndpoint(handle.db, tenantId);
    const doc = await addDocument();
    expect(await storeFor(tenantId).approveFound(doc.id, RESOLUTION)).toBe(true);
    expect(await readDoc()).toMatchObject({
      status: 'approved',
      sifenMessages: [{ code: '0422', message: 'CDC encontrado' }],
    });
    const events = await handle.db.select().from(webhookDeliveries);
    expect(events.map((e) => e.eventType).sort()).toEqual([
      'document.approved',
      'document.submitted',
    ]);
  });

  it('refuses a document that was not queued again by the recovery (no resent_at)', async () => {
    const doc = await addDocument({ resentAt: null });
    expect(await storeFor(tenantId).approveFound(doc.id, RESOLUTION)).toBe(false);
    expect((await readDoc()).status).toBe('queued');
  });

  it.each(['submitted', 'approved', 'rejected', 'signed'])(
    'refuses a %s document: only queued ones are waiting to be resent',
    async (status) => {
      const doc = await addDocument({ status });
      expect(await storeFor(tenantId).approveFound(doc.id, RESOLUTION)).toBe(false);
      expect((await readDoc()).status).toBe(status);
    },
  );

  it.each(['pending', 'sending', 'sent', 'unknown', 'recovery'])(
    'refuses a document already carried by a lote in process (%s): another path owns it',
    async (loteStatus) => {
      const doc = await addDocument();
      const [lote] = await handle.db
        .insert(lotes)
        .values({ tenantId, environment: 'test', documentType: 1, status: loteStatus })
        .returning();
      await handle.db
        .insert(loteDocuments)
        .values({ tenantId, loteId: lote.id, documentId: doc.id });
      expect(await storeFor(tenantId).approveFound(doc.id, RESOLUTION)).toBe(false);
      expect((await readDoc()).status).toBe('queued');
    },
  );

  it('does not touch a document of another tenant', async () => {
    const doc = await addDocument();
    expect(await storeFor(otherTenantId).approveFound(doc.id, RESOLUTION)).toBe(false);
    expect((await readDoc()).status).toBe('queued');
  });
});
