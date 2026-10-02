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
  withTenantTransaction,
  type DatabaseHandle,
} from '@sifen/db';
import { createDrizzleLoteAssemblyStore } from './drizzle-lote-assembly-store.js';

const cdcOf = (n: number): string =>
  `0180069563100100100000${String(n).padStart(2, '0')}12026010111234567891`;

/** Spec: HU-E6-02 (S3). LoteAssemblyStore over documents + lotes, run as app_user under RLS. */
describe('DrizzleLoteAssemblyStore', () => {
  let handle: DatabaseHandle;
  let tenantId: string;
  let otherTenantId: string;
  let fiscal: { timbradoId: string; establishmentId: string; expeditionPointId: string };
  let counter: number;

  beforeEach(async () => {
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
    counter = 0;
  });

  afterEach(async () => {
    await handle.close();
  });

  const storeFor = (tenant: string, batchSize?: number) =>
    createDrizzleLoteAssemblyStore({ db: handle.db, tenantId: tenant, batchSize });

  async function addDocument(
    status: string,
    signedXml: string | null = '<rDE/>',
    createdAt?: Date,
  ) {
    counter += 1;
    const [row] = await handle.db
      .insert(documents)
      .values({
        tenantId,
        environment: 'test',
        ...fiscal,
        documentType: 1,
        number: counter,
        cdc: cdcOf(counter),
        securityCode: '123456789',
        status,
        signedXml,
        createdAt,
        signedAt: signedXml ? new Date('2026-01-01T12:00:05Z') : null,
        issuedAt: new Date('2026-01-01T12:00:00Z'),
        totalAmount: '110000',
        payload: {},
      })
      .returning();
    return row;
  }

  async function addLote(status: string, documentIds: readonly string[]) {
    const [lote] = await handle.db
      .insert(lotes)
      .values({ tenantId, environment: 'test', documentType: 1, status })
      .returning();
    await handle.db
      .insert(loteDocuments)
      .values(documentIds.map((documentId) => ({ tenantId, loteId: lote.id, documentId })));
    return lote;
  }

  const statusOf = (id: string) =>
    withTenantTransaction(handle.db, tenantId, (tx) =>
      tx.select({ status: documents.status }).from(documents).where(eq(documents.id, id)),
    ).then((rows) => rows[0].status);

  describe('readyDocuments', () => {
    it('returns signed and queued documents with their XML, oldest first', async () => {
      const queued = await addDocument('queued', '<rDE>q</rDE>');
      const signed = await addDocument('signed', '<rDE>s</rDE>');
      await addDocument('accepted', null);
      await addDocument('signed', null);
      await addDocument('submitted');
      await addDocument('cancelled');
      expect(await storeFor(tenantId).readyDocuments()).toEqual([
        { documentId: queued.id, cdc: queued.cdc, xml: '<rDE>q</rDE>' },
        { documentId: signed.id, cdc: signed.cdc, xml: '<rDE>s</rDE>' },
      ]);
    });

    it('breaks ties on created_at by document id so batches are stable', async () => {
      const sameInstant = new Date('2026-01-01T00:00:00Z');
      const first = await addDocument('signed', '<rDE/>', sameInstant);
      const second = await addDocument('signed', '<rDE/>', sameInstant);
      const ids = (await storeFor(tenantId).readyDocuments()).map((d) => d.documentId);
      expect(ids).toEqual([first.id, second.id].sort());
    });

    it('returns nothing for another tenant', async () => {
      await addDocument('signed');
      expect(await storeFor(otherTenantId).readyDocuments()).toEqual([]);
    });

    it('reads at most batchSize documents', async () => {
      await addDocument('signed');
      await addDocument('signed');
      await addDocument('signed');
      expect(await storeFor(tenantId, 2).readyDocuments()).toHaveLength(2);
    });
  });

  describe('cdcsInProcess', () => {
    it.each([
      ['pending', true],
      ['sending', true],
      ['sent', true],
      ['unknown', true],
      ['recovery', true],
      ['rejected', false],
      ['processed', false],
    ])('a document in a %s lote is in process: %s', async (status, inProcess) => {
      const document = await addDocument('queued');
      await addLote(status, [document.id]);
      const found = await storeFor(tenantId).cdcsInProcess([document.cdc]);
      expect([...found]).toEqual(inProcess ? [document.cdc] : []);
    });

    it('only reports the CDCs asked about, and none for an empty list', async () => {
      const a = await addDocument('queued');
      const b = await addDocument('queued');
      await addLote('pending', [a.id, b.id]);
      expect([...(await storeFor(tenantId).cdcsInProcess([a.cdc]))]).toEqual([a.cdc]);
      expect((await storeFor(tenantId).cdcsInProcess([])).size).toBe(0);
    });
  });

  describe('createLote', () => {
    it('creates a pending lote, links the documents and queues them', async () => {
      const a = await addDocument('signed');
      const b = await addDocument('signed');
      const loteId = await storeFor(tenantId).createLote({
        documentType: 1,
        documentIds: [a.id, b.id],
      });
      expect(loteId).not.toBeNull();
      const [lote] = await handle.db.select().from(lotes);
      expect(lote).toMatchObject({
        id: loteId,
        tenantId,
        environment: 'test',
        documentType: 1,
        status: 'pending',
      });
      const links = await handle.db.select().from(loteDocuments);
      expect(links.map((l) => l.documentId).sort()).toEqual([a.id, b.id].sort());
      expect(await statusOf(a.id)).toBe('queued');
      expect(await statusOf(b.id)).toBe('queued');
    });

    it('writes nothing and returns null when a document is not ready', async () => {
      const ready = await addDocument('signed');
      const accepted = await addDocument('accepted', null);
      const loteId = await storeFor(tenantId).createLote({
        documentType: 1,
        documentIds: [ready.id, accepted.id],
      });
      expect(loteId).toBeNull();
      expect(await handle.db.select().from(lotes)).toEqual([]);
      expect(await statusOf(ready.id)).toBe('signed');
    });

    it('returns null for a document already in a lote in process', async () => {
      const document = await addDocument('queued');
      await addLote('pending', [document.id]);
      const loteId = await storeFor(tenantId).createLote({
        documentType: 1,
        documentIds: [document.id],
      });
      expect(loteId).toBeNull();
      expect(await handle.db.select().from(lotes)).toHaveLength(1);
    });

    it('re-queues a queued document whose lote was rejected', async () => {
      const document = await addDocument('queued');
      await addLote('rejected', [document.id]);
      const loteId = await storeFor(tenantId).createLote({
        documentType: 1,
        documentIds: [document.id],
      });
      expect(loteId).not.toBeNull();
      expect(await handle.db.select().from(lotes)).toHaveLength(2);
      expect(await statusOf(document.id)).toBe('queued');
    });

    it('lets only one of two concurrent assemblers take the same documents', async () => {
      const document = await addDocument('signed');
      const store = storeFor(tenantId);
      const input = { documentType: 1, documentIds: [document.id] };
      const results = await Promise.all([store.createLote(input), store.createLote(input)]);
      expect(results.filter((id) => id !== null)).toHaveLength(1);
      expect(await handle.db.select().from(lotes)).toHaveLength(1);
    });

    it("returns null for another tenant's documents", async () => {
      const document = await addDocument('signed');
      const loteId = await storeFor(otherTenantId).createLote({
        documentType: 1,
        documentIds: [document.id],
      });
      expect(loteId).toBeNull();
      expect(await statusOf(document.id)).toBe('signed');
    });

    it('rejects an empty document list', async () => {
      await expect(
        storeFor(tenantId).createLote({ documentType: 1, documentIds: [] }),
      ).rejects.toThrow(/at least one/);
    });
  });
});
