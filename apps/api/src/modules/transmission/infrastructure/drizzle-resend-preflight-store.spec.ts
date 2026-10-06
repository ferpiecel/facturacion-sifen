import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import {
  auditLog,
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

  /** A document the recovery queued again: carried by a closed lote, stamped, attempt counted. */
  async function addDocument(overrides: Partial<typeof documents.$inferInsert> = {}) {
    counter += 1;
    const { resentAt, ...rest } = overrides;
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
        issuedAt: new Date('2026-01-01T12:00:00Z'),
        totalAmount: '110000',
        payload: {},
        ...rest,
      })
      .returning();
    if (resentAt !== null && row.status === 'queued') {
      const [closed] = await handle.db
        .insert(lotes)
        .values({ tenantId, environment: 'test', documentType: 1, status: 'processed' })
        .returning();
      await handle.db
        .insert(loteDocuments)
        .values({ tenantId, loteId: closed.id, documentId: row.id });
      await handle.db
        .update(documents)
        .set({ resentAt: resentAt ?? new Date(), transmissionAttempts: 1 })
        .where(eq(documents.id, row.id));
    }
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

  it('audits the approval as the system actor, in the same transaction', async () => {
    const doc = await addDocument();
    await storeFor(tenantId).approveFound(doc.id, RESOLUTION);
    const audits = await handle.db.select().from(auditLog);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actorType: 'system',
      actorId: 'transmission-worker',
      action: 'document.approved_on_resend_check',
      entityId: doc.id,
      before: { status: 'queued' },
      after: { status: 'approved' },
    });
  });

  it('writes no audit row when it refuses', async () => {
    const doc = await addDocument({ resentAt: null });
    await storeFor(tenantId).approveFound(doc.id, RESOLUTION);
    expect(await handle.db.select().from(auditLog)).toEqual([]);
  });

  it('approves a document waiting for its resend although the older lote it left is still recovery', async () => {
    const doc = await addDocument({ resentAt: null });
    const [old] = await handle.db
      .insert(lotes)
      .values({ tenantId, environment: 'test', documentType: 1, status: 'recovery' })
      .returning();
    await handle.db.insert(loteDocuments).values({ tenantId, loteId: old.id, documentId: doc.id });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await handle.db.execute(
      sql`update documents set resent_at = now(), transmission_attempts = 1 where id = ${doc.id}`,
    );
    expect(await storeFor(tenantId).approveFound(doc.id, RESOLUTION)).toBe(true);
  });

  it('locks the document row before it decides, so a lote being assembled cannot slip past', async () => {
    // createLote locks its documents FOR UPDATE; approveFound must wait on that lock in a statement
    // of its own and only then look for lotes in process (a later snapshot sees the new lote).
    const doc = await addDocument();
    const statements: string[] = [];
    const logged = drizzle((handle.db as unknown as { $client: never }).$client, {
      logger: { logQuery: (query) => statements.push(query) },
    });
    const spied = createDrizzleResendPreflightStore({
      db: logged as unknown as typeof handle.db,
      tenantId,
    });
    expect(await spied.approveFound(doc.id, RESOLUTION)).toBe(true);
    const lockAt = statements.findIndex((q) => /^select .* for update/i.test(q));
    const firstUpdate = statements.findIndex((q) => /^update "documents"/i.test(q));
    const lotesCheck = statements.findIndex((q) => /"lote_documents"/i.test(q));
    expect(lockAt).toBeGreaterThan(-1);
    expect(lockAt).toBeLessThan(lotesCheck);
    expect(lotesCheck).toBeLessThan(firstUpdate);
  });
});
