import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  createPgliteDatabase,
  documents,
  loteDocuments,
  auditLog,
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
import { createDrizzleLoteDispatchStore } from './drizzle-lote-dispatch-store.js';

const NOW = new Date('2026-10-01T12:00:00.000Z');

/** Spec: HU-E6-02 (S2). LoteDispatchStore over `lotes`, run as app_user under RLS. */
describe('DrizzleLoteDispatchStore', () => {
  let handle: DatabaseHandle;
  let tenantId: string;
  let otherTenantId: string;
  let loteId: string;

  beforeEach(async () => {
    handle = createPgliteDatabase();
    await handle.migrate();
    const [a, b] = await handle.db
      .insert(tenants)
      .values([{ name: 'A' }, { name: 'B' }])
      .returning();
    tenantId = a.id;
    otherTenantId = b.id;
    const [lote] = await handle.db
      .insert(lotes)
      .values({ tenantId, environment: 'test', documentType: 1 })
      .returning();
    loteId = lote.id;
  });

  afterEach(async () => {
    await handle.close();
  });

  const storeFor = (tenant: string, maxTransmissionAttempts?: number) =>
    createDrizzleLoteDispatchStore({
      db: handle.db,
      tenantId: tenant,
      now: () => NOW,
      maxTransmissionAttempts,
    });
  const readLote = () =>
    withTenantTransaction(handle.db, tenantId, (tx) =>
      tx.select().from(lotes).where(eq(lotes.id, loteId)),
    ).then((rows) => rows[0]);

  /** Links one document per status to the lote; returns their CDCs by status. */
  async function seedDocuments(statuses: readonly string[]): Promise<Record<string, string>> {
    const { db } = handle;
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
    const cdcs: Record<string, string> = {};
    for (const [i, status] of statuses.entries()) {
      const cdc = `0180069563100100100000${String(i + 1).padStart(2, '0')}12026010111234567891`;
      cdcs[status] = cdc;
      const [document] = await db
        .insert(documents)
        .values({
          tenantId,
          environment: 'test',
          timbradoId: timbrado.id,
          establishmentId: est.id,
          expeditionPointId: point.id,
          documentType: 1,
          number: i + 1,
          cdc,
          securityCode: '123456789',
          status,
          issuedAt: new Date('2026-01-01T12:00:00Z'),
          totalAmount: '110000',
          payload: {},
        })
        .returning();
      await db.insert(loteDocuments).values({ tenantId, loteId, documentId: document.id });
    }
    return cdcs;
  }
  const readDocument = (cdc: string) =>
    withTenantTransaction(handle.db, tenantId, (tx) =>
      tx.select().from(documents).where(eq(documents.cdc, cdc)),
    ).then((rows) => rows[0]);
  const statusOf = (cdc: string) =>
    withTenantTransaction(handle.db, tenantId, (tx) =>
      tx.select({ status: documents.status }).from(documents).where(eq(documents.cdc, cdc)),
    ).then((rows) => rows[0].status);

  it('claims a pending lote once', async () => {
    const store = storeFor(tenantId);
    expect(await store.claim(loteId)).toBe(true);
    expect((await readLote()).status).toBe('sending');
    expect(await store.claim(loteId)).toBe(false);
  });

  it('stamps the instant of the send attempt when the lote is claimed, once', async () => {
    const store = storeFor(tenantId);
    expect((await readLote()).sendAttemptedAt).toBeNull();
    await store.claim(loteId);
    expect((await readLote()).sendAttemptedAt).toEqual(NOW);
    const later = createDrizzleLoteDispatchStore({
      db: handle.db,
      tenantId,
      now: () => new Date(NOW.getTime() + 3_600_000),
    });
    expect(await later.claim(loteId)).toBe(false);
    expect((await readLote()).sendAttemptedAt).toEqual(NOW);
  });

  it('keeps the send attempt instant whatever the outcome', async () => {
    const store = storeFor(tenantId);
    await store.claim(loteId);
    await store.record(loteId, { status: 'unknown', reason: 'timed out' });
    expect(await readLote()).toMatchObject({
      status: 'unknown',
      sendAttemptedAt: NOW,
      sentAt: null,
    });
  });

  it('lets only one of two concurrent claims win', async () => {
    const store = storeFor(tenantId);
    const results = await Promise.all([store.claim(loteId), store.claim(loteId)]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('does not claim a lote of another tenant', async () => {
    expect(await storeFor(otherTenantId).claim(loteId)).toBe(false);
    expect((await readLote()).status).toBe('pending');
  });

  it('records sent with the protocol and the poll schedule', async () => {
    const store = storeFor(tenantId);
    await store.claim(loteId);
    await store.record(loteId, { status: 'sent', dProtConsLote: '4500123' });
    expect(await readLote()).toMatchObject({
      status: 'sent',
      sifenProtocol: '4500123',
      sentAt: NOW,
      nextPollAt: new Date('2026-10-01T12:10:00.000Z'),
      pollDeadlineAt: new Date('2026-10-03T12:00:00.000Z'),
    });
  });

  it('records rejected with the code and the reason', async () => {
    const store = storeFor(tenantId);
    await store.claim(loteId);
    await store.record(loteId, { status: 'rejected', code: '0301', reason: 'RUC bloqueado' });
    expect(await readLote()).toMatchObject({
      status: 'rejected',
      responseCode: '0301',
      responseMessage: 'RUC bloqueado',
      sifenProtocol: null,
    });
  });

  it('records unknown with the reason and no poll schedule', async () => {
    const store = storeFor(tenantId);
    await store.claim(loteId);
    await store.record(loteId, { status: 'unknown', reason: 'timed out' });
    expect(await readLote()).toMatchObject({
      status: 'unknown',
      responseMessage: 'timed out',
      nextPollAt: null,
    });
  });

  it('refuses to record an outcome for a lote that was not claimed', async () => {
    await expect(
      storeFor(tenantId).record(loteId, { status: 'sent', dProtConsLote: '1' }),
    ).rejects.toThrow(/not in sending/);
    expect((await readLote()).status).toBe('pending');
  });

  describe('a send that finishes after the sweep moved the lote to unknown', () => {
    /** claim, then what `sweepStaleSending` does to a lote whose outcome was never recorded. */
    async function sweptLote() {
      await storeFor(tenantId).claim(loteId);
      await handle.db.update(lotes).set({ status: 'unknown' }).where(eq(lotes.id, loteId));
    }

    it('still records the protocol, the poll schedule and submits the documents', async () => {
      const cdcs = await seedDocuments(['queued']);
      await sweptLote();
      await storeFor(tenantId).record(loteId, { status: 'sent', dProtConsLote: '4500123' });
      expect(await readLote()).toMatchObject({
        status: 'sent',
        sifenProtocol: '4500123',
        nextPollAt: new Date('2026-10-01T12:10:00.000Z'),
      });
      expect(await statusOf(cdcs.queued)).toBe('submitted');
    });

    it('records a 0301 refusal of it and backs the documents off', async () => {
      const cdcs = await seedDocuments(['queued']);
      await sweptLote();
      await storeFor(tenantId).record(loteId, {
        status: 'rejected',
        code: '0301',
        reason: 'RUC bloqueado',
      });
      expect((await readLote()).status).toBe('rejected');
      expect((await readDocument(cdcs.queued)).transmissionAttempts).toBe(1);
    });

    it('clears the recovery hold of the documents SIFEN did receive, with an audit row each', async () => {
      await seedDocuments(['queued', 'queued', 'queued', 'approved']);
      const byNumber = await handle.db
        .select({ cdc: documents.cdc })
        .from(documents)
        .orderBy(documents.number);
      const [recoveryHeld, otherHeld, plain, approved] = byNumber.map((d) => d.cdc);
      const hold = (cdc: string, reason: string) =>
        handle.db.update(documents).set({ transmissionHold: reason }).where(eq(documents.cdc, cdc));
      await hold(recoveryHeld, 'recovery:0420-unresolved');
      await hold(otherHeld, 'signing:CertificateNotFoundError');
      await hold(approved, 'recovery:0420-unresolved');
      await sweptLote();

      await storeFor(tenantId).record(loteId, { status: 'sent', dProtConsLote: '4500123' });

      expect(await readDocument(recoveryHeld)).toMatchObject({
        status: 'submitted',
        transmissionHold: null,
      });
      expect(await readDocument(otherHeld)).toMatchObject({
        status: 'submitted',
        transmissionHold: 'signing:CertificateNotFoundError',
      });
      expect(await readDocument(plain)).toMatchObject({ status: 'submitted' });
      expect(await readDocument(approved)).toMatchObject({
        status: 'approved',
        transmissionHold: 'recovery:0420-unresolved',
      });
      const audits = await handle.db.select().from(auditLog);
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({
        action: 'document.hold_released',
        entityType: 'document',
        actorType: 'system',
        actorId: 'transmission-worker',
        before: { transmissionHold: 'recovery:0420-unresolved' },
        after: { transmissionHold: null },
      });
    });

    it('still refuses a lote that recovery already closed', async () => {
      await sweptLote();
      await handle.db.update(lotes).set({ status: 'processed' }).where(eq(lotes.id, loteId));
      await expect(
        storeFor(tenantId).record(loteId, { status: 'sent', dProtConsLote: '1' }),
      ).rejects.toThrow(/not in sending or unknown/);
      expect((await readLote()).sifenProtocol).toBeNull();
    });
  });

  it('marks the queued documents of a sent lote as submitted', async () => {
    const cdcs = await seedDocuments(['queued', 'cancelled']);
    const store = storeFor(tenantId);
    await store.claim(loteId);
    await store.record(loteId, { status: 'sent', dProtConsLote: '4500123' });
    expect(await statusOf(cdcs.queued)).toBe('submitted');
    // Anything else is left alone: recording must not fail once SIFEN holds the lote.
    expect(await statusOf(cdcs.cancelled)).toBe('cancelled');
  });

  it('keeps the documents queued when the lote is rejected, so they can be re-queued', async () => {
    const cdcs = await seedDocuments(['queued']);
    const store = storeFor(tenantId);
    await store.claim(loteId);
    await store.record(loteId, { status: 'rejected', code: '0301', reason: 'RUC bloqueado' });
    expect(await statusOf(cdcs.queued)).toBe('queued');
  });

  it('keeps the documents queued when the outcome is unknown', async () => {
    const cdcs = await seedDocuments(['queued']);
    const store = storeFor(tenantId);
    await store.claim(loteId);
    await store.record(loteId, { status: 'unknown', reason: 'timed out' });
    expect(await statusOf(cdcs.queued)).toBe('queued');
  });

  it('backs off the documents of a rejected lote, doubling the wait on each refusal', async () => {
    const cdcs = await seedDocuments(['queued']);
    const store = storeFor(tenantId);
    await store.claim(loteId);
    await store.record(loteId, { status: 'rejected', code: '0301', reason: 'RUC bloqueado' });
    expect(await readDocument(cdcs.queued)).toMatchObject({
      transmissionAttempts: 1,
      nextTransmissionAt: new Date('2026-10-01T12:05:00.000Z'),
      transmissionHold: null,
    });

    // The same document in a later lote, refused again.
    const [next] = await handle.db
      .insert(lotes)
      .values({ tenantId, environment: 'test', documentType: 1 })
      .returning();
    await handle.db
      .insert(loteDocuments)
      .values({ tenantId, loteId: next.id, documentId: (await readDocument(cdcs.queued)).id });
    await store.claim(next.id);
    await store.record(next.id, { status: 'rejected', code: '0301', reason: 'again' });
    expect(await readDocument(cdcs.queued)).toMatchObject({
      transmissionAttempts: 2,
      nextTransmissionAt: new Date('2026-10-01T12:10:00.000Z'),
    });
  });

  it('holds a document for the operator once its attempts reach the cap, never dropping it', async () => {
    const cdcs = await seedDocuments(['queued']);
    const store = storeFor(tenantId, 1);
    await store.claim(loteId);
    await store.record(loteId, { status: 'rejected', code: '0301', reason: 'RUC bloqueado' });
    expect(await readDocument(cdcs.queued)).toMatchObject({
      status: 'queued',
      transmissionAttempts: 1,
      nextTransmissionAt: null,
      transmissionHold: 'transmission:attempts-exhausted',
    });
  });

  it('does not count an unknown or a sent outcome as a refusal', async () => {
    const cdcs = await seedDocuments(['queued']);
    const store = storeFor(tenantId);
    await store.claim(loteId);
    await store.record(loteId, { status: 'unknown', reason: 'timed out' });
    expect(await readDocument(cdcs.queued)).toMatchObject({
      transmissionAttempts: 0,
      nextTransmissionAt: null,
    });
  });

  it('enqueues a document.submitted event for each document that moved to submitted (outbox)', async () => {
    await seedWebhookEndpoint(handle.db, tenantId);
    await seedDocuments(['queued', 'accepted']);
    const store = storeFor(tenantId);
    await store.claim(loteId);
    await store.record(loteId, { status: 'sent', dProtConsLote: '4500123' });
    const rows = await handle.db.select().from(webhookDeliveries);
    expect(rows.map((r) => r.eventType)).toEqual(['document.submitted']);
  });
});
