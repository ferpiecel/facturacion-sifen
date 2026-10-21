import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  createPgliteDatabase,
  documents,
  issuerEvents,
  tenantEstablishments,
  tenantExpeditionPoints,
  tenants,
  tenantTimbrados,
  withTenantTransaction,
  type DatabaseHandle,
} from '@sifen/db';
import { createDrizzleEventSigningStore } from './drizzle-event-signing-store.js';

const NOW = new Date('2026-10-17T12:00:00.000Z');
const CDC = '01800695631001001000000112026010111234567891';
const RANGE = { timbrado: '12345678', establishment: '001', point: '001', from: 1, to: 5, type: 1 };

/** Spec: HU-E8-04 (slice D). EventSigningStore over `issuer_events`, run as app_user under RLS. */
describe('DrizzleEventSigningStore', () => {
  let handle: DatabaseHandle;
  let tenantId: string;
  let otherTenantId: string;
  let documentId: string;

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
    const [doc] = await db
      .insert(documents)
      .values({
        tenantId,
        environment: 'test',
        timbradoId: timbrado.id,
        establishmentId: est.id,
        expeditionPointId: point.id,
        documentType: 1,
        number: 1,
        cdc: CDC,
        securityCode: '123456789',
        issuedAt: NOW,
        totalAmount: '110000',
        payload: { items: [] },
      })
      .returning();
    documentId = doc.id;
  });

  afterEach(async () => {
    await handle.close();
  });

  const storeFor = (tenant: string) =>
    createDrizzleEventSigningStore({ db: handle.db, tenantId: tenant });

  const insertEvent = async (overrides: Partial<typeof issuerEvents.$inferInsert>) => {
    const [row] = await handle.db
      .insert(issuerEvents)
      .values({
        tenantId,
        environment: 'test',
        kind: 'cancellation',
        eventId: 1n,
        documentId,
        reason: 'Error en los datos',
        ...overrides,
      })
      .returning();
    return row.id;
  };
  const read = (id: string) =>
    withTenantTransaction(handle.db, tenantId, (tx) =>
      tx.select().from(issuerEvents).where(eq(issuerEvents.id, id)),
    ).then((rows) => rows[0]);

  it('lists the pending events of its tenant, oldest first, up to the limit', async () => {
    const first = await insertEvent({ eventId: 1n, createdAt: new Date(NOW.getTime() - 60_000) });
    const second = await insertEvent({
      kind: 'voiding',
      eventId: 2n,
      documentId: null,
      voidRange: RANGE,
      createdAt: NOW,
    });
    await insertEvent({
      eventId: 3n,
      tenantId: otherTenantId,
      documentId: null,
      kind: 'voiding',
      voidRange: RANGE,
    });

    expect(await storeFor(tenantId).pendingEventIds(10)).toEqual([first, second]);
    expect(await storeFor(tenantId).pendingEventIds(1)).toEqual([first]);
    expect(await storeFor(otherTenantId).pendingEventIds(10)).toHaveLength(1);
  });

  it('parks a pending event for an operator: it keeps its place in the table but is no longer listed', async () => {
    const parked = await insertEvent({ eventId: 1n });
    const other = await insertEvent({
      kind: 'voiding',
      eventId: 2n,
      documentId: null,
      voidRange: RANGE,
    });

    await storeFor(tenantId).holdEvent(parked, 'signing:EventDataIncompleteError');

    expect(await storeFor(tenantId).pendingEventIds(10)).toEqual([other]);
    const [row] = await handle.db.select().from(issuerEvents).where(eq(issuerEvents.id, parked));
    expect(row).toMatchObject({
      status: 'pending',
      responseCode: null,
      responseMessage: 'signing:EventDataIncompleteError',
    });
  });

  it('loads a cancellation with the CDC of its document and the tenant environment', async () => {
    const id = await insertEvent({});

    expect(await storeFor(tenantId).load(id)).toEqual({
      id,
      status: 'pending',
      environment: 'test',
      tenantEnvironment: 'test',
      eventId: 1n,
      kind: 'cancellation',
      reason: 'Error en los datos',
      cdc: CDC,
      voidRange: null,
    });
  });

  it('loads a voiding with its range and no CDC', async () => {
    const id = await insertEvent({ kind: 'voiding', documentId: null, voidRange: RANGE });

    expect(await storeFor(tenantId).load(id)).toMatchObject({
      kind: 'voiding',
      cdc: null,
      voidRange: RANGE,
    });
  });

  it('does not load the event of another tenant', async () => {
    const foreign = await insertEvent({
      tenantId: otherTenantId,
      kind: 'voiding',
      documentId: null,
      voidRange: RANGE,
    });

    expect(await storeFor(tenantId).load(foreign)).toBeUndefined();
  });

  it('stores the signature once: pending to signed, and a second call changes nothing', async () => {
    const id = await insertEvent({});

    expect(await storeFor(tenantId).markSigned(id, { signedXml: '<a/>', signedAt: NOW })).toBe(
      true,
    );
    expect(await storeFor(tenantId).markSigned(id, { signedXml: '<b/>', signedAt: NOW })).toBe(
      false,
    );

    expect(await read(id)).toMatchObject({ status: 'signed', signedXml: '<a/>', signedAt: NOW });
  });
});
