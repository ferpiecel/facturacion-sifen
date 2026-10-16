import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  createPgliteDatabase,
  issuerEvents,
  tenants,
  withTenantTransaction,
  type DatabaseHandle,
} from '@sifen/db';
import { FakeSifenGateway, sifenScenarios } from '@sifen/sifen-gateway';
import { SendEventBatch } from '../application/send-event-batch.js';
import { createDrizzleEventBatchStore } from './drizzle-event-batch-store.js';

const NOW = new Date('2026-10-16T12:00:00.000Z');
const XML = (n: number) => `<gGroupGesEve>${String(n)}</gGroupGesEve>`;
const RANGE = { timbrado: '12345678', establishment: '001', point: '001', from: 1, to: 5, type: 1 };

/** Spec: HU-E8-04 (slice C). EventBatchStore over `issuer_events`, run as app_user under RLS. */
describe('DrizzleEventBatchStore', () => {
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
    tenantId = a.id;
    otherTenantId = b.id;
  });

  afterEach(async () => {
    await handle.close();
  });

  const storeFor = (tenant: string) =>
    createDrizzleEventBatchStore({ db: handle.db, tenantId: tenant, now: () => NOW });

  async function signedEvent(tenant: string, eventId: number, minutesAgo = 0) {
    const createdAt = new Date(NOW.getTime() - minutesAgo * 60_000);
    const [row] = await handle.db
      .insert(issuerEvents)
      .values({
        tenantId: tenant,
        environment: 'test',
        kind: 'voiding',
        eventId: BigInt(eventId),
        voidRange: RANGE,
        reason: 'Numeros sin uso',
        createdAt,
      })
      .returning();
    await handle.db
      .update(issuerEvents)
      .set({ status: 'signed', signedXml: XML(eventId), signedAt: createdAt })
      .where(eq(issuerEvents.id, row.id));
    return row.id;
  }

  const read = (id: string) =>
    withTenantTransaction(handle.db, tenantId, (tx) =>
      tx.select().from(issuerEvents).where(eq(issuerEvents.id, id)),
    ).then((rows) => rows[0]);

  it('lists the signed events of its tenant, oldest first, up to the limit', async () => {
    const newest = await signedEvent(tenantId, 1, 1);
    const oldest = await signedEvent(tenantId, 2, 30);
    await signedEvent(tenantId, 3, 10);
    await handle.db.insert(issuerEvents).values({
      tenantId,
      environment: 'test',
      kind: 'voiding',
      eventId: 4n,
      voidRange: RANGE,
      reason: 'Aun sin firmar',
    });

    const listed = await storeFor(tenantId).signedEvents(2);

    expect(listed.map((e) => e.id)).toEqual([oldest, expect.any(String)]);
    expect(listed).toHaveLength(2);
    expect(listed[0]).toEqual({ id: oldest, eventId: 2n, signedXml: XML(2) });
    expect(listed.map((e) => e.id)).not.toContain(newest);
  });

  it('never sees the events of another tenant', async () => {
    await signedEvent(otherTenantId, 1);

    expect(await storeFor(tenantId).signedEvents(15)).toEqual([]);
  });

  it('claims signed events for a send, once, and stamps the batch id and the attempt', async () => {
    const id = await signedEvent(tenantId, 1);

    const claimed = await storeFor(tenantId).claim([id], 55n);
    const again = await storeFor(tenantId).claim([id], 56n);

    expect(claimed).toEqual([{ id, eventId: 1n, signedXml: XML(1) }]);
    expect(again).toEqual([]);
    const row = await read(id);
    expect(row).toMatchObject({ status: 'sending', batchDId: 55n, sendAttemptedAt: NOW });
  });

  it('cannot claim the event of another tenant', async () => {
    const foreign = await signedEvent(otherTenantId, 1);

    expect(await storeFor(tenantId).claim([foreign], 1n)).toEqual([]);
  });

  it('does not claim an event of an environment the tenant has left', async () => {
    const id = await signedEvent(tenantId, 1);
    await handle.db
      .update(tenants)
      .set({ environment: 'production' })
      .where(eq(tenants.id, tenantId));

    expect(await storeFor(tenantId).claim([id], 1n)).toEqual([]);
    expect(await storeFor(tenantId).signedEvents(15)).toEqual([]);
    expect((await read(id)).status).toBe('signed');
  });

  it('rejects unsent events locally: no batch id, no attempt, a local code', async () => {
    const id = await signedEvent(tenantId, 1);

    await storeFor(tenantId).rejectUnsent(
      new Map([[id, { code: 'LOC-XSD', message: 'not valid' }]]),
    );

    expect(await read(id)).toMatchObject({
      status: 'rejected',
      responseCode: 'LOC-XSD',
      responseMessage: 'not valid',
      respondedAt: NOW,
      batchDId: null,
      sendAttemptedAt: null,
    });
  });

  it('refuses a local rejection of an event that is no longer signed, and rejects none then', async () => {
    const signed = await signedEvent(tenantId, 1);
    const sending = await signedEvent(tenantId, 2);
    await storeFor(tenantId).claim([sending], 4n);

    await expect(
      storeFor(tenantId).rejectUnsent(
        new Map([
          [signed, { code: 'LOC-XSD', message: 'x' }],
          [sending, { code: 'LOC-XSD', message: 'x' }],
        ]),
      ),
    ).rejects.toThrow(/not waiting/);

    expect((await read(signed)).status).toBe('signed');
  });

  it('settles approved, rejected and unknown outcomes on the rows', async () => {
    const [a, b, c] = [
      await signedEvent(tenantId, 1),
      await signedEvent(tenantId, 2),
      await signedEvent(tenantId, 3),
    ];
    const store = storeFor(tenantId);
    await store.claim([a, b, c], 9n);

    await store.record(
      new Map([
        [a, { status: 'approved', code: '0600', message: 'Evento registrado correctamente' }],
        [b, { status: 'rejected', code: '4009', message: 'Plazo extemporaneo' }],
        [c, { status: 'unknown', reason: 'timed out' }],
      ]),
    );

    expect(await read(a)).toMatchObject({
      status: 'approved',
      responseCode: '0600',
      responseMessage: 'Evento registrado correctamente',
      respondedAt: NOW,
    });
    expect(await read(b)).toMatchObject({ status: 'rejected', responseCode: '4009' });
    expect(await read(c)).toMatchObject({
      status: 'unknown',
      responseCode: null,
      responseMessage: 'timed out',
      respondedAt: null,
    });
  });

  it('refuses to settle an event that is not being sent, and settles nothing then', async () => {
    const sending = await signedEvent(tenantId, 1);
    const notSent = await signedEvent(tenantId, 2);
    const store = storeFor(tenantId);
    await store.claim([sending], 9n);

    await expect(
      store.record(
        new Map([
          [sending, { status: 'approved', code: '0600', message: 'ok' }],
          [notSent, { status: 'approved', code: '0600', message: 'ok' }],
        ]),
      ),
    ).rejects.toThrow(/not being sent/);

    expect((await read(sending)).status).toBe('sending');
  });

  it('runs a whole send: a mixed answer settles each row, and the next run finds nothing', async () => {
    const [a, b, c] = [
      await signedEvent(tenantId, 1),
      await signedEvent(tenantId, 2),
      await signedEvent(tenantId, 3),
    ];
    const gateway = new FakeSifenGateway();
    gateway.enqueue(
      'enviarEventos',
      sifenScenarios.eventosProcesados([
        { id: '1', dEstRes: 'Aprobado', mensajes: [{ dCodRes: '0600', dMsgRes: 'ok' }] },
        { id: '2', dEstRes: 'Rechazado', mensajes: [{ dCodRes: '4009', dMsgRes: 'tarde' }] },
      ]),
    );
    const send = new SendEventBatch({
      gateway,
      store: storeFor(tenantId),
      nextRequestId: () => Promise.resolve(321n),
      validate: () => ({ valid: true, errors: [] }),
    });

    expect(await send.execute()).toEqual({ status: 'sent', approved: 1, rejected: 1, unknown: 1 });
    expect(await send.execute()).toEqual({ status: 'empty' });

    expect(await read(a)).toMatchObject({ status: 'approved', batchDId: 321n });
    expect(await read(b)).toMatchObject({ status: 'rejected', responseCode: '4009' });
    expect(await read(c)).toMatchObject({ status: 'unknown' });
  });
});
