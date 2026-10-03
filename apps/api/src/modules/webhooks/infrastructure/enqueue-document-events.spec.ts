import { eq } from 'drizzle-orm';
import {
  createPgliteDatabase,
  documents,
  tenants,
  webhookDeliveries,
  webhookEndpoints,
  withTenantTransaction,
  type DatabaseHandle,
} from '@sifen/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { seedDocuments } from '../../../../test/support/document-seed.js';
import { enqueueDocumentEvents } from './enqueue-document-events.js';

const AT = new Date('2026-10-01T12:00:00.000Z');
const SEALED = {
  v: 1,
  keyId: 'k',
  wrappedKey: 'AA==',
  nonce: 'AA==',
  tag: 'AA==',
  ciphertext: 'AA==',
};

/** Spec: HU-E11-01 (S4). One delivery per active matching endpoint, in the caller's transaction. */
describe('enqueueDocumentEvents', () => {
  let handle: DatabaseHandle;
  let tenantId: string;
  let otherTenantId: string;

  beforeEach(async () => {
    handle = createPgliteDatabase();
    await handle.migrate();
    const [a, b] = await handle.db
      .insert(tenants)
      .values([{ name: 'A' }, { name: 'B' }])
      .returning();
    [tenantId, otherTenantId] = [a.id, b.id];
  });
  afterEach(async () => {
    await handle.close();
  });

  const endpoint = async (
    over: Partial<typeof webhookEndpoints.$inferInsert> = {},
    tenant = tenantId,
  ) =>
    (
      await handle.db
        .insert(webhookEndpoints)
        .values({ tenantId: tenant, url: 'https://h.example.com/x', sealed: SEALED, ...over })
        .returning()
    )[0].id;
  const deliveries = () => handle.db.select().from(webhookDeliveries);
  const enqueue = (documentIds: string[]) =>
    withTenantTransaction(handle.db, tenantId, (tx) =>
      enqueueDocumentEvents(tx, { tenantId, documentIds, at: AT }),
    );

  it('enqueues a pending delivery due now per active endpoint, with the minimal envelope', async () => {
    const all = await endpoint();
    const [doc] = await seedDocuments(handle.db, tenantId, ['approved']);
    await handle.db
      .update(documents)
      .set({ sifenMessages: [{ code: '0260', message: 'Aprobado' }] })
      .where(eq(documents.id, doc.id));
    await enqueue([doc.id]);
    const [row] = await deliveries();
    expect(row).toMatchObject({
      endpointId: all,
      tenantId,
      eventType: 'document.approved',
      status: 'pending',
      attemptCount: 0,
      nextAttemptAt: AT,
    });
    expect(row.payload).toEqual({
      id: row.eventId,
      type: 'document.approved',
      created_at: AT.toISOString(),
      tenant_id: tenantId,
      data: {
        document_id: doc.id,
        cdc: doc.cdc,
        document_type: 1,
        status: 'approved',
        sifen_messages: [{ code: '0260', message: 'Aprobado' }],
      },
    });
    expect(JSON.stringify(row.payload)).not.toContain('Private Person');
  });

  it('honours the events filter and skips inactive endpoints and other tenants', async () => {
    const matching = await endpoint({ events: ['document.approved'] });
    await endpoint({ events: ['document.rejected'] });
    await endpoint({ active: false });
    await endpoint({}, otherTenantId);
    const [doc] = await seedDocuments(handle.db, tenantId, ['approved']);
    await enqueue([doc.id]);
    expect((await deliveries()).map((d) => d.endpointId)).toEqual([matching]);
  });

  it('is idempotent per document, event and endpoint', async () => {
    await endpoint();
    const [doc] = await seedDocuments(handle.db, tenantId, ['submitted']);
    await enqueue([doc.id]);
    await enqueue([doc.id]);
    expect(await deliveries()).toHaveLength(1);
  });

  it('handles several documents at once and ignores statuses that emit nothing', async () => {
    await endpoint();
    const docs = await seedDocuments(handle.db, tenantId, ['signed', 'queued', 'rejected']);
    await enqueue(docs.map((d) => d.id));
    expect((await deliveries()).map((d) => d.eventType).sort()).toEqual([
      'document.rejected',
      'document.signed',
    ]);
  });

  it('does nothing without documents or endpoints', async () => {
    await enqueue([]);
    const [doc] = await seedDocuments(handle.db, tenantId, ['approved']);
    await enqueue([doc.id]);
    expect(await deliveries()).toEqual([]);
  });

  it('rolls back with the caller transaction (transactional outbox)', async () => {
    await endpoint();
    const [doc] = await seedDocuments(handle.db, tenantId, ['approved']);
    await expect(
      withTenantTransaction(handle.db, tenantId, async (tx) => {
        await enqueueDocumentEvents(tx, { tenantId, documentIds: [doc.id], at: AT });
        throw new Error('status change failed');
      }),
    ).rejects.toThrow('status change failed');
    expect(await deliveries()).toEqual([]);
  });
});
