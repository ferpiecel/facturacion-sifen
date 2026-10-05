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
  webhookDeliveries,
  withTenantTransaction,
  type DatabaseHandle,
} from '@sifen/db';
import { seedWebhookEndpoint } from '../../../../test/support/document-seed.js';
import type { LoteRecoveryOutcome } from '../application/recover-lote-by-cdc.js';
import { createDrizzleLoteRecoveryStore } from './drizzle-lote-recovery-store.js';

const SENT_AT = new Date('2026-10-01T12:00:00.000Z');
const HANDED_OVER_AT = new Date('2026-10-03T12:05:00.000Z');
const RECOVERED_AT = new Date('2026-10-03T12:16:00.000Z');
const CDC_A = '01800695631001001000000112026010111234567891';
const CDC_B = '01800695631001001000000212026010111234567892';

/** Spec: HU-E6-04 (S1). LoteRecoveryStore over lotes + documents, run as app_user under RLS. */
describe('DrizzleLoteRecoveryStore', () => {
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
        nextPollAt: SENT_AT,
        pollDeadlineAt: new Date('2026-10-03T12:00:00.000Z'),
      })
      .returning();
    loteId = lote.id;
    await db
      .insert(loteDocuments)
      .values(docs.map((d) => ({ tenantId, loteId, documentId: d.id })));
    await withTenantTransaction(db, tenantId, (tx) =>
      tx
        .update(lotes)
        .set({ status: 'recovery', nextPollAt: null, lastPolledAt: HANDED_OVER_AT })
        .where(eq(lotes.id, loteId)),
    );
  });

  afterEach(async () => {
    await handle.close();
  });

  const storeFor = (tenant: string) =>
    createDrizzleLoteRecoveryStore({ db: handle.db, tenantId: tenant });
  const guard = {
    expectedStatus: 'recovery',
    expectedLastPolledAt: HANDED_OVER_AT as Date | null,
    recoveredAt: RECOVERED_AT,
  };
  const readLote = () =>
    withTenantTransaction(handle.db, tenantId, (tx) =>
      tx.select().from(lotes).where(eq(lotes.id, loteId)),
    ).then((rows) => rows[0]);
  const readDoc = (cdc: string) =>
    withTenantTransaction(handle.db, tenantId, (tx) =>
      tx.select().from(documents).where(eq(documents.cdc, cdc)),
    ).then((rows) => rows[0]);
  const approval = (cdc: string) => ({
    cdc,
    status: 'approved' as const,
    messages: [{ code: '0422', message: 'CDC encontrado' }],
  });
  const recovered: LoteRecoveryOutcome = {
    resolutions: [approval(CDC_A), approval(CDC_B)],
    unresolved: [],
  };

  it('loads the recovery lote with its last query time and still-submitted CDCs', async () => {
    const state = await storeFor(tenantId).load(loteId);
    expect(state).toMatchObject({ loteId, status: 'recovery', lastPolledAt: HANDED_OVER_AT });
    expect([...(state?.cdcs ?? [])].sort()).toEqual([CDC_A, CDC_B]);
  });

  it('lists only the CDCs that are still submitted', async () => {
    await withTenantTransaction(handle.db, tenantId, (tx) =>
      tx.update(documents).set({ status: 'approved' }).where(eq(documents.cdc, CDC_A)),
    );
    expect((await storeFor(tenantId).load(loteId))?.cdcs).toEqual([CDC_B]);
  });

  it('does not load an unknown lote or one of another tenant', async () => {
    expect(await storeFor(tenantId).load('00000000-0000-0000-0000-000000000000')).toBeNull();
    expect(await storeFor(otherTenantId).load(loteId)).toBeNull();
  });

  it('approves every document and marks the lote processed in one transaction', async () => {
    expect(await storeFor(tenantId).record(loteId, recovered, guard)).toBe(true);
    expect(await readLote()).toMatchObject({
      status: 'processed',
      lastPolledAt: RECOVERED_AT,
      lastPollMessage: null,
    });
    expect(await readDoc(CDC_A)).toMatchObject({
      status: 'approved',
      sifenMessages: [{ code: '0422', message: 'CDC encontrado' }],
    });
    expect((await readDoc(CDC_B)).status).toBe('approved');
  });

  it('keeps the lote in recovery while a CDC is unresolved and stamps the query', async () => {
    const applied = await storeFor(tenantId).record(
      loteId,
      {
        resolutions: [approval(CDC_A)],
        unresolved: [{ cdc: CDC_B, reason: '0420: CDC inexistente' }],
      },
      guard,
    );
    expect(applied).toBe(true);
    expect(await readLote()).toMatchObject({
      status: 'recovery',
      lastPolledAt: RECOVERED_AT,
      lastPollMessage: expect.stringContaining('1') as string,
    });
    expect((await readDoc(CDC_A)).status).toBe('approved');
    expect((await readDoc(CDC_B)).status).toBe('submitted');
  });

  it('writes nothing when last_polled_at changed since the load', async () => {
    const applied = await storeFor(tenantId).record(loteId, recovered, {
      ...guard,
      expectedLastPolledAt: new Date('2026-10-03T12:00:00.000Z'),
    });
    expect(applied).toBe(false);
    expect((await readLote()).status).toBe('recovery');
    expect((await readDoc(CDC_A)).status).toBe('submitted');
  });

  it('matches last_polled_at stored with microseconds, and a null one', async () => {
    await handle.db.execute(
      sql`update lotes set last_polled_at = '2026-10-03 12:05:00.123456+00' where id = ${loteId}`,
    );
    const store = storeFor(tenantId);
    const state = await store.load(loteId);
    expect(state?.lastPolledAt).toEqual(new Date('2026-10-03T12:05:00.123Z'));
    expect(
      await store.record(loteId, recovered, {
        ...guard,
        expectedLastPolledAt: state?.lastPolledAt ?? null,
      }),
    ).toBe(true);
  });

  it('matches a lote that was never queried', async () => {
    await handle.db.execute(sql`update lotes set last_polled_at = null where id = ${loteId}`);
    expect(
      await storeFor(tenantId).record(loteId, recovered, { ...guard, expectedLastPolledAt: null }),
    ).toBe(true);
  });

  it('writes nothing when the lote is no longer in recovery', async () => {
    const store = storeFor(tenantId);
    await store.record(loteId, recovered, guard);
    expect(await store.record(loteId, recovered, guard)).toBe(false);
  });

  it('lets only one of two concurrent records win', async () => {
    const store = storeFor(tenantId);
    const results = await Promise.all([
      store.record(loteId, recovered, guard),
      store.record(loteId, recovered, guard),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('does not write for another tenant', async () => {
    expect(await storeFor(otherTenantId).record(loteId, recovered, guard)).toBe(false);
    expect((await readLote()).status).toBe('recovery');
  });

  it('rolls the lote back when a document is not submitted', async () => {
    await withTenantTransaction(handle.db, tenantId, (tx) =>
      tx.update(documents).set({ status: 'cancelled' }).where(eq(documents.cdc, CDC_B)),
    );
    await expect(storeFor(tenantId).record(loteId, recovered, guard)).rejects.toThrow(CDC_B);
    expect((await readLote()).status).toBe('recovery');
    expect((await readDoc(CDC_A)).status).toBe('submitted');
  });

  it('enqueues one document.approved event per settled document in the same transaction', async () => {
    await seedWebhookEndpoint(handle.db, tenantId);
    await storeFor(tenantId).record(loteId, recovered, guard);
    const deliveries = await handle.db.select().from(webhookDeliveries);
    expect(deliveries.map((d) => d.eventType)).toEqual(['document.approved', 'document.approved']);
  });

  /** A second lote (inserted directly, in any status) with its own documents. */
  async function seedLote(status: string, documentStatus: string, cdcs: string[]) {
    const { db } = handle;
    const [est] = await db.select().from(tenantEstablishments);
    const [point] = await db.select().from(tenantExpeditionPoints);
    const [timbrado] = await db.select().from(tenantTimbrados);
    const docs = await db
      .insert(documents)
      .values(
        cdcs.map((cdc, i) => ({
          tenantId,
          environment: 'test' as const,
          timbradoId: timbrado.id,
          establishmentId: est.id,
          expeditionPointId: point.id,
          documentType: 1,
          number: 100 + i,
          cdc,
          securityCode: '123456789',
          status: documentStatus,
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
        status,
        lastPollMessage: status === 'processed' ? '1 document(s) need recovery' : null,
      })
      .returning();
    await db
      .insert(loteDocuments)
      .values(docs.map((d) => ({ tenantId, loteId: lote.id, documentId: d.id })));
    return lote.id;
  }
  const CDC_C = '01800695631001001000000312026010111234567893';
  const CDC_D = '01800695631001001000000412026010111234567894';
  const readLoteById = (id: string) =>
    withTenantTransaction(handle.db, tenantId, (tx) =>
      tx.select().from(lotes).where(eq(lotes.id, id)),
    ).then((rows) => rows[0]);
  const unknownGuard = { ...guard, expectedStatus: 'unknown', expectedLastPolledAt: null };

  describe('lote sent without an answer (unknown)', () => {
    it('loads the queued CDCs: SIFEN may hold them although the send was never confirmed', async () => {
      const unknown = await seedLote('unknown', 'queued', [CDC_C, CDC_D]);
      const state = await storeFor(tenantId).load(unknown);
      expect(state).toMatchObject({ status: 'unknown', lastPolledAt: null });
      expect([...(state?.cdcs ?? [])].sort()).toEqual([CDC_C, CDC_D]);
    });

    it('approves a found CDC through submitted, with both events, and closes the lote', async () => {
      await seedWebhookEndpoint(handle.db, tenantId);
      const unknown = await seedLote('unknown', 'queued', [CDC_C, CDC_D]);
      const applied = await storeFor(tenantId).record(
        unknown,
        { resolutions: [approval(CDC_C), approval(CDC_D)], unresolved: [] },
        unknownGuard,
      );
      expect(applied).toBe(true);
      expect(await readLoteById(unknown)).toMatchObject({ status: 'processed' });
      expect((await readDoc(CDC_C)).status).toBe('approved');
      const events = await handle.db.select().from(webhookDeliveries);
      expect(events.map((e) => e.eventType).sort()).toEqual([
        'document.approved',
        'document.approved',
        'document.submitted',
        'document.submitted',
      ]);
    });

    it('keeps the lote unknown while a CDC is unresolved and leaves that document queued', async () => {
      const unknown = await seedLote('unknown', 'queued', [CDC_C, CDC_D]);
      await storeFor(tenantId).record(
        unknown,
        { resolutions: [approval(CDC_C)], unresolved: [{ cdc: CDC_D, reason: '0420' }] },
        unknownGuard,
      );
      expect((await readLoteById(unknown)).status).toBe('unknown');
      expect((await readDoc(CDC_C)).status).toBe('approved');
      expect((await readDoc(CDC_D)).status).toBe('queued');
    });

    it('writes nothing when the expected status is not the lote status', async () => {
      const unknown = await seedLote('unknown', 'queued', [CDC_C]);
      expect(
        await storeFor(tenantId).record(
          unknown,
          { resolutions: [approval(CDC_C)], unresolved: [] },
          { ...unknownGuard, expectedStatus: 'recovery' },
        ),
      ).toBe(false);
      expect((await readDoc(CDC_C)).status).toBe('queued');
    });
  });

  describe('lote processed with documents left submitted', () => {
    it('loads the submitted CDCs and settles them, keeping the lote processed', async () => {
      const done = await seedLote('processed', 'submitted', [CDC_C, CDC_D]);
      const store = storeFor(tenantId);
      expect([...((await store.load(done))?.cdcs ?? [])].sort()).toEqual([CDC_C, CDC_D]);
      const processedGuard = { ...guard, expectedStatus: 'processed', expectedLastPolledAt: null };
      await store.record(
        done,
        { resolutions: [approval(CDC_C)], unresolved: [{ cdc: CDC_D, reason: '0420' }] },
        processedGuard,
      );
      expect((await readLoteById(done)).status).toBe('processed');
      expect((await readDoc(CDC_C)).status).toBe('approved');
      expect((await store.load(done))?.cdcs).toEqual([CDC_D]);
    });
  });

  describe('hand-over reason', () => {
    it('is kept when a pass leaves CDCs unresolved, without piling up, and when it settles them', async () => {
      await handle.db.execute(
        sql`update lotes set last_poll_message = '0364: Consulta extemporanea' where id = ${loteId}`,
      );
      const store = storeFor(tenantId);
      const pending = { resolutions: [approval(CDC_A)], unresolved: [{ cdc: CDC_B, reason: 'x' }] };
      await store.record(loteId, pending, guard);
      const first = (await readLote()).lastPollMessage ?? '';
      expect(first).toContain('0364: Consulta extemporanea');
      expect(first).toContain('1 document(s) still unresolved');

      await store.record(
        loteId,
        { resolutions: [], unresolved: [{ cdc: CDC_B, reason: 'x' }] },
        {
          ...guard,
          expectedLastPolledAt: RECOVERED_AT,
          recoveredAt: new Date('2026-10-03T12:30:00Z'),
        },
      );
      const second = (await readLote()).lastPollMessage ?? '';
      expect(second.match(/0364: Consulta extemporanea/g)).toHaveLength(1);
      expect(second.match(/still unresolved/g)).toHaveLength(1);

      await store.record(
        loteId,
        { resolutions: [approval(CDC_B)], unresolved: [] },
        {
          ...guard,
          expectedLastPolledAt: new Date('2026-10-03T12:30:00Z'),
          recoveredAt: new Date('2026-10-03T12:45:00Z'),
        },
      );
      expect(await readLote()).toMatchObject({
        status: 'processed',
        lastPollMessage: '0364: Consulta extemporanea',
      });
    });
  });
});
