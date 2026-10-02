import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
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
import type { LotePollOutcome } from '../application/poll-lote-result.js';
import { createDrizzleLotePollStore } from './drizzle-lote-poll-store.js';

const SENT_AT = new Date('2026-10-01T12:00:00.000Z');
const NEXT_POLL = new Date('2026-10-01T12:10:00.000Z');
const POLLED_AT = new Date('2026-10-01T12:11:00.000Z');
const CDC_A = '01800695631001001000000112026010111234567891';
const CDC_B = '01800695631001001000000212026010111234567892';

/** Spec: HU-E6-03 (S2). LotePollStore over lotes + documents, run as app_user under RLS. */
describe('DrizzleLotePollStore', () => {
  let handle: DatabaseHandle;
  let tenantId: string;
  let otherTenantId: string;
  let loteId: string;

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
    const docs = await db
      .insert(documents)
      .values(
        [CDC_A, CDC_B].map((cdc, i) => ({
          tenantId,
          environment: 'test' as const,
          timbradoId: timbrado.id,
          establishmentId: est.id,
          expeditionPointId: point.id,
          documentType: 1,
          number: i + 1,
          cdc,
          securityCode: '123456789',
          status: 'submitted',
          issuedAt: new Date('2026-01-01T12:00:00Z'),
          totalAmount: '110000',
          payload: {},
        })),
      )
      .returning();
    const [lote] = await db
      .insert(lotes)
      .values({
        tenantId,
        environment: 'test',
        documentType: 1,
        status: 'sent',
        sifenProtocol: '4500123',
        sentAt: SENT_AT,
        nextPollAt: NEXT_POLL,
        pollDeadlineAt: new Date('2026-10-03T12:00:00.000Z'),
      })
      .returning();
    loteId = lote.id;
    await db
      .insert(loteDocuments)
      .values(docs.map((d) => ({ tenantId, loteId, documentId: d.id })));
  });

  afterEach(async () => {
    await handle.close();
  });

  const storeFor = (tenant: string) =>
    createDrizzleLotePollStore({ db: handle.db, tenantId: tenant });
  const guard = { expectedNextPollAt: NEXT_POLL, polledAt: POLLED_AT };
  const readLote = () =>
    withTenantTransaction(handle.db, tenantId, (tx) =>
      tx.select().from(lotes).where(eq(lotes.id, loteId)),
    ).then((rows) => rows[0]);
  const readDoc = (cdc: string) =>
    withTenantTransaction(handle.db, tenantId, (tx) =>
      tx.select().from(documents).where(eq(documents.cdc, cdc)),
    ).then((rows) => rows[0]);

  const processed: LotePollOutcome = {
    status: 'processed',
    resolutions: [
      { cdc: CDC_A, status: 'approved', messages: [{ code: '0260', message: 'ok' }] },
      { cdc: CDC_B, status: 'rejected', messages: [{ code: '1000', message: 'bad' }] },
    ],
    needsRecovery: [],
  };

  it('loads the lote with its protocol, schedule and document CDCs', async () => {
    const state = await storeFor(tenantId).load(loteId);
    expect(state).toMatchObject({
      loteId,
      status: 'sent',
      dProtConsLote: '4500123',
      nextPollAt: NEXT_POLL,
      pollDeadlineAt: new Date('2026-10-03T12:00:00.000Z'),
    });
    expect([...(state?.cdcs ?? [])].sort()).toEqual([CDC_A, CDC_B]);
  });

  it('does not load an unknown lote or one of another tenant', async () => {
    expect(await storeFor(tenantId).load('00000000-0000-0000-0000-000000000000')).toBeNull();
    expect(await storeFor(otherTenantId).load(loteId)).toBeNull();
  });

  it('records pending as a reschedule that keeps the lote sent', async () => {
    const next = new Date('2026-10-01T12:21:00.000Z');
    const applied = await storeFor(tenantId).record(
      loteId,
      { status: 'pending', nextPollAt: next, reason: '0361: Lote en procesamiento' },
      guard,
    );
    expect(applied).toBe(true);
    expect(await readLote()).toMatchObject({
      status: 'sent',
      nextPollAt: next,
      lastPolledAt: POLLED_AT,
      lastPollMessage: '0361: Lote en procesamiento',
    });
  });

  it('records processed and updates every document in the same transaction', async () => {
    expect(await storeFor(tenantId).record(loteId, processed, guard)).toBe(true);
    expect(await readLote()).toMatchObject({ status: 'processed', nextPollAt: null });
    expect(await readDoc(CDC_A)).toMatchObject({
      status: 'approved',
      sifenMessages: [{ code: '0260', message: 'ok' }],
    });
    expect(await readDoc(CDC_B)).toMatchObject({
      status: 'rejected',
      sifenMessages: [{ code: '1000', message: 'bad' }],
    });
  });

  it('leaves documents that need recovery untouched and says so on the lote', async () => {
    await storeFor(tenantId).record(
      loteId,
      { status: 'processed', resolutions: [processed.resolutions[0]], needsRecovery: [CDC_B] },
      guard,
    );
    expect((await readDoc(CDC_B)).status).toBe('submitted');
    expect((await readLote()).lastPollMessage).toContain('1');
  });

  it('records recovery with the reason and stops scheduling', async () => {
    await storeFor(tenantId).record(loteId, { status: 'recovery', reason: '0364: tarde' }, guard);
    expect(await readLote()).toMatchObject({
      status: 'recovery',
      nextPollAt: null,
      lastPollMessage: '0364: tarde',
    });
  });

  it('writes nothing when next_poll_at changed since the load', async () => {
    const applied = await storeFor(tenantId).record(loteId, processed, {
      ...guard,
      expectedNextPollAt: new Date('2026-10-01T12:00:00.000Z'),
    });
    expect(applied).toBe(false);
    expect((await readLote()).status).toBe('sent');
    expect((await readDoc(CDC_A)).status).toBe('submitted');
  });

  it('matches next_poll_at even when it was stored with microseconds', async () => {
    await handle.db.execute(
      sql`update lotes set next_poll_at = '2026-10-01 12:10:00.123456+00' where id = ${loteId}`,
    );
    const store = storeFor(tenantId);
    const state = await store.load(loteId);
    expect(state?.nextPollAt).toEqual(new Date('2026-10-01T12:10:00.123Z'));
    const applied = await store.record(loteId, processed, {
      ...guard,
      expectedNextPollAt: state?.nextPollAt as Date,
    });
    expect(applied).toBe(true);
    expect((await readLote()).status).toBe('processed');
  });

  it('writes nothing when the lote is no longer sent', async () => {
    const store = storeFor(tenantId);
    await store.record(loteId, { status: 'recovery', reason: 'x' }, guard);
    expect(await store.record(loteId, processed, guard)).toBe(false);
    expect((await readLote()).status).toBe('recovery');
  });

  it('lets only one of two concurrent records win', async () => {
    const store = storeFor(tenantId);
    const results = await Promise.all([
      store.record(loteId, processed, guard),
      store.record(loteId, processed, guard),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('does not write for another tenant', async () => {
    expect(await storeFor(otherTenantId).record(loteId, processed, guard)).toBe(false);
    expect((await readLote()).status).toBe('sent');
  });

  it('rolls the lote back when a document is not submitted', async () => {
    await withTenantTransaction(handle.db, tenantId, (tx) =>
      tx.update(documents).set({ status: 'cancelled' }).where(eq(documents.cdc, CDC_B)),
    );
    await expect(storeFor(tenantId).record(loteId, processed, guard)).rejects.toThrow(CDC_B);
    expect((await readLote()).status).toBe('sent');
    expect((await readDoc(CDC_A)).status).toBe('submitted');
  });

  it('accepts a document already settled with the same status', async () => {
    await withTenantTransaction(handle.db, tenantId, (tx) =>
      tx.update(documents).set({ status: 'approved' }).where(eq(documents.cdc, CDC_A)),
    );
    expect(await storeFor(tenantId).record(loteId, processed, guard)).toBe(true);
    expect((await readDoc(CDC_B)).status).toBe('rejected');
  });
});
