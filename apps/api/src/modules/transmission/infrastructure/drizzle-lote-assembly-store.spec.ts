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

  const storeFor = (tenant: string, batchSize?: number, now?: () => Date) =>
    createDrizzleLoteAssemblyStore({ db: handle.db, tenantId: tenant, batchSize, now });

  async function addDocument(
    status: string,
    signedXml: string | null = '<rDE/>',
    createdAt?: Date,
    environment: 'test' | 'production' = 'test',
  ) {
    counter += 1;
    const [row] = await handle.db
      .insert(documents)
      .values({
        tenantId,
        environment,
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

  /** Queues a document "again" the way the recovery does: carried by a closed lote, stamped, attempt counted. */
  async function stampResent(id: string, resentAt: Date) {
    await addLote('processed', [id]);
    await handle.db
      .update(documents)
      .set({ resentAt, transmissionAttempts: 1 })
      .where(eq(documents.id, id));
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
        { documentId: queued.id, cdc: queued.cdc, xml: '<rDE>q</rDE>', resent: false },
        { documentId: signed.id, cdc: signed.cdc, xml: '<rDE>s</rDE>', resent: false },
      ]);
    });

    it('does not reassemble a held queued document of a processed lote until it is released', async () => {
      const doc = await addDocument('queued');
      await addLote('processed', [doc.id]);
      const set = (values: Partial<typeof documents.$inferInsert>) =>
        handle.db.update(documents).set(values).where(eq(documents.id, doc.id));
      const ids = async () => (await storeFor(tenantId).readyDocuments()).map((d) => d.documentId);

      await set({ transmissionHold: 'recovery:0420-unresolved' });
      expect(await ids()).toEqual([]);
      await set({ transmissionHold: null });
      expect(await ids()).toEqual([doc.id]);
    });

    it('flags the documents the recovery queued again (resent_at), and only those', async () => {
      const plain = await addDocument('queued');
      const again = await addDocument('queued');
      await stampResent(again.id, new Date('2026-10-05T12:00:00Z'));
      const rows = await storeFor(tenantId).readyDocuments();
      expect(rows.map((r) => [r.documentId, r.resent])).toEqual([
        [plain.id, false],
        [again.id, true],
      ]);
    });

    it('leaves out documents that are held or still backing off, and takes them once due', async () => {
      const now = new Date('2026-10-05T09:00:00.000Z');
      const due = await addDocument('queued');
      const backing = await addDocument('queued');
      const held = await addDocument('queued');
      const set = (id: string, values: Partial<typeof documents.$inferInsert>) =>
        handle.db.update(documents).set(values).where(eq(documents.id, id));
      await set(due.id, { nextTransmissionAt: new Date('2026-10-05T08:59:00.000Z') });
      await set(backing.id, { nextTransmissionAt: new Date('2026-10-05T09:01:00.000Z') });
      await set(held.id, { transmissionHold: 'transmission:attempts-exhausted' });

      const ids = async (at: Date) =>
        (await storeFor(tenantId, undefined, () => at).readyDocuments()).map((d) => d.documentId);
      expect(await ids(now)).toEqual([due.id]);
      expect(await ids(new Date('2026-10-05T09:02:00.000Z'))).toEqual([due.id, backing.id]);
    });

    it('breaks ties on created_at by document id so batches are stable', async () => {
      const sameInstant = new Date('2026-01-01T00:00:00Z');
      const first = await addDocument('signed', '<rDE/>', sameInstant);
      const second = await addDocument('signed', '<rDE/>', sameInstant);
      const ids = (await storeFor(tenantId).readyDocuments()).map((d) => d.documentId);
      expect(ids).toEqual([first.id, second.id].sort());
    });

    it("ignores documents of the tenant's previous environment without starving the rest", async () => {
      await addDocument('signed');
      await handle.db
        .update(tenants)
        .set({ environment: 'production' })
        .where(eq(tenants.id, tenantId));
      const current = await addDocument('signed', '<rDE/>', undefined, 'production');
      const ready = await storeFor(tenantId, 1).readyDocuments();
      expect(ready.map((d) => d.documentId)).toEqual([current.id]);
    });

    it('leaves out documents that a lote in process already carries', async () => {
      const taken = await addDocument('queued');
      const freed = await addDocument('queued');
      await addLote('pending', [taken.id]);
      await addLote('rejected', [freed.id]);
      const ready = await storeFor(tenantId).readyDocuments();
      expect(ready.map((d) => d.documentId)).toEqual([freed.id]);
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

    it('returns null for a held document', async () => {
      const held = await addDocument('signed');
      await handle.db
        .update(documents)
        .set({ transmissionHold: 'transmission:attempts-exhausted' })
        .where(eq(documents.id, held.id));
      expect(
        await storeFor(tenantId).createLote({ documentType: 1, documentIds: [held.id] }),
      ).toBeNull();
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

    it('returns null for a document of another environment or another type', async () => {
      const stale = await addDocument('signed');
      await handle.db
        .update(tenants)
        .set({ environment: 'production' })
        .where(eq(tenants.id, tenantId));
      const store = storeFor(tenantId);
      expect(await store.createLote({ documentType: 1, documentIds: [stale.id] })).toBeNull();
      const current = await addDocument('signed', '<rDE/>', undefined, 'production');
      expect(await store.createLote({ documentType: 4, documentIds: [current.id] })).toBeNull();
      expect(await statusOf(current.id)).toBe('signed');
    });

    it('accepts repeated document ids once', async () => {
      const document = await addDocument('signed');
      const loteId = await storeFor(tenantId).createLote({
        documentType: 1,
        documentIds: [document.id, document.id],
      });
      expect(loteId).not.toBeNull();
      expect(await handle.db.select().from(loteDocuments)).toHaveLength(1);
    });

    it('stamps updated_at when it queues a document', async () => {
      const document = await addDocument('signed');
      const now = new Date('2026-10-05T09:00:00.000Z');
      await storeFor(tenantId, undefined, () => now).createLote({
        documentType: 1,
        documentIds: [document.id],
      });
      const [row] = await handle.db.select().from(documents).where(eq(documents.id, document.id));
      expect(row.updatedAt).toEqual(now);
    });

    it('rejects an empty document list', async () => {
      await expect(
        storeFor(tenantId).createLote({ documentType: 1, documentIds: [] }),
      ).rejects.toThrow(/at least one/);
    });
  });

  describe('documents the recovery queued again (HU-E6-04)', () => {
    const RESENT = new Date('2099-01-01T00:00:00Z');
    const setDoc = (id: string, values: Partial<typeof documents.$inferInsert>) =>
      handle.db.update(documents).set(values).where(eq(documents.id, id));
    const stamp = stampResent;
    const readDoc = (id: string) =>
      withTenantTransaction(handle.db, tenantId, (tx) =>
        tx.select().from(documents).where(eq(documents.id, id)),
      ).then((rows) => rows[0]);

    it('returns when it was queued again', async () => {
      const doc = await addDocument('queued');
      await stamp(doc.id, RESENT);
      expect((await storeFor(tenantId).readyDocuments())[0]).toMatchObject({
        resent: true,
        resentAt: RESENT,
      });
    });

    it('defers only a queued, resent, unheld document, until the given instant', async () => {
      const resent = await addDocument('queued');
      const plain = await addDocument('queued');
      const held = await addDocument('queued');
      await stamp(resent.id, RESENT);
      await stamp(held.id, RESENT);
      await setDoc(held.id, { transmissionHold: 'x:y' });
      const until = new Date('2099-01-02T00:00:00Z');
      for (const id of [resent.id, plain.id, held.id])
        await storeFor(tenantId).deferDocument(id, until);
      expect((await readDoc(resent.id)).nextTransmissionAt).toEqual(until);
      expect((await readDoc(plain.id)).nextTransmissionAt).toBeNull();
      expect((await readDoc(held.id)).nextTransmissionAt).toBeNull();
    });

    it('holds only a queued, resent, unheld document', async () => {
      const resent = await addDocument('queued');
      const plain = await addDocument('queued');
      await stamp(resent.id, RESENT);
      await storeFor(tenantId).holdResend(resent.id, 'resend:precheck-unresolved');
      await storeFor(tenantId).holdResend(plain.id, 'resend:precheck-unresolved');
      expect((await readDoc(resent.id)).transmissionHold).toBe('resend:precheck-unresolved');
      expect((await readDoc(plain.id)).transmissionHold).toBeNull();
    });

    it('is not blocked by the older lote it left, but is by a newer one that carries it', async () => {
      const doc = await addDocument('queued');
      const old = await addLote('recovery', [doc.id]);
      expect((await storeFor(tenantId).readyDocuments()).map((d) => d.documentId)).toEqual([]);
      // Queued again after that lote existed: the old lote is no longer its business.
      await new Promise((resolve) => setTimeout(resolve, 20));
      await setDoc(doc.id, { resentAt: new Date(), transmissionAttempts: 1 });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect((await storeFor(tenantId).readyDocuments()).map((d) => d.documentId)).toEqual([
        doc.id,
      ]);
      expect((await storeFor(tenantId).cdcsInProcess([doc.cdc])).size).toBe(0);
      expect(old.status).toBe('recovery');
      const created = await storeFor(tenantId).createLote({
        documentType: 1,
        documentIds: [doc.id],
      });
      expect(created).not.toBeNull();
      // A newer lote carrying it blocks again.
      expect((await storeFor(tenantId).readyDocuments()).map((d) => d.documentId)).toEqual([]);
      expect((await storeFor(tenantId).cdcsInProcess([doc.cdc])).has(doc.cdc)).toBe(true);
    });
  });
});
