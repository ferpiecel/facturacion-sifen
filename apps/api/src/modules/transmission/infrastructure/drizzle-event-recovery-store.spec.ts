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
import { createDrizzleEventRecoveryStore } from './drizzle-event-recovery-store.js';

const NOW = new Date('2026-10-17T12:00:00.000Z');
const minutesAgo = (n: number) => new Date(NOW.getTime() - n * 60_000);
const cdcOf = (n: number) =>
  `0180069563100100100000${String(n).padStart(2, '0')}12026010111234567891`;
const RANGE = { timbrado: '12345678', establishment: '001', point: '001', from: 1, to: 5, type: 1 };

/** Spec: HU-E8-04 (slice D). EventRecoveryStore over `issuer_events`, run as app_user under RLS. */
describe('DrizzleEventRecoveryStore', () => {
  let handle: DatabaseHandle;
  let tenantId: string;
  let otherTenantId: string;
  let fiscal: { timbradoId: string; establishmentId: string; expeditionPointId: string };
  let seq = 0;
  const cdcs = new Map<string, string>();

  beforeEach(async () => {
    seq = 0;
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
    createDrizzleEventRecoveryStore({
      db: handle.db,
      tenantId: tenant,
      now: () => NOW,
      claimLeaseMs: 0,
    });
  const read = (id: string) =>
    withTenantTransaction(handle.db, tenantId, (tx) =>
      tx.select().from(issuerEvents).where(eq(issuerEvents.id, id)),
    ).then((rows) => rows[0]);

  /** An event in `status`, sent `sentMinutesAgo` minutes before NOW. */
  async function event(
    status: 'sending' | 'unknown',
    sentMinutesAgo: number,
    overrides: Partial<typeof issuerEvents.$inferInsert> = {},
    kind: 'cancellation' | 'voiding' | 'nomination' = 'cancellation',
  ) {
    seq += 1;
    const tenant = overrides.tenantId ?? tenantId;
    // One document per cancellation: an open event of a kind per document is unique.
    const documentId =
      kind !== 'voiding'
        ? (
            await handle.db
              .insert(documents)
              .values({
                tenantId,
                environment: 'test',
                ...fiscal,
                documentType: 1,
                number: seq,
                cdc: cdcOf(seq),
                securityCode: '123456789',
                issuedAt: NOW,
                totalAmount: '110000',
                payload: { items: [] },
              })
              .returning()
          )[0].id
        : undefined;
    const cdc = cdcOf(seq);
    const [row] = await handle.db
      .insert(issuerEvents)
      .values({
        tenantId: tenant,
        environment: 'test',
        kind,
        eventId: BigInt(seq),
        ...(documentId ? { documentId } : { voidRange: RANGE }),
        ...(kind === 'nomination' ? { nomination: { kind: 'non-taxpayer' } } : {}),
        reason: 'Error en los datos',
        ...overrides,
      })
      .returning();
    await handle.db
      .update(issuerEvents)
      .set({ status: 'signed', signedXml: '<a/>', signedAt: NOW })
      .where(eq(issuerEvents.id, row.id));
    await handle.db
      .update(issuerEvents)
      .set({ status: 'sending', batchDId: 5n, sendAttemptedAt: minutesAgo(sentMinutesAgo) })
      .where(eq(issuerEvents.id, row.id));
    if (status === 'unknown') {
      await handle.db
        .update(issuerEvents)
        .set({ status: 'unknown' })
        .where(eq(issuerEvents.id, row.id));
    }
    cdcs.set(row.id, cdc);
    return row.id;
  }

  it('turns sending events attempted before the cutoff into unknown, and no others', async () => {
    const stale = await event('sending', 45);
    const fresh = await event('sending', 5);

    const swept = await storeFor(tenantId).sweepStaleSending(minutesAgo(30), 10);

    expect(swept).toBe(1);
    expect((await read(stale)).status).toBe('unknown');
    expect((await read(fresh)).status).toBe('sending');
  });

  it('honours the limit, oldest attempt first, and never touches another tenant', async () => {
    const oldest = await event('sending', 90);
    const older = await event('sending', 60);
    const foreign = await event('sending', 120, { tenantId: otherTenantId }, 'voiding');

    expect(await storeFor(tenantId).sweepStaleSending(minutesAgo(30), 1)).toBe(1);

    expect((await read(oldest)).status).toBe('unknown');
    expect((await read(older)).status).toBe('sending');
    const [other] = await handle.db.select().from(issuerEvents).where(eq(issuerEvents.id, foreign));
    expect(other.status).toBe('sending');
  });

  it('lists unknown cancellations sent before the cutoff with their CDC, least recently looked at first', async () => {
    const older = await event('unknown', 60);
    const newer = await event('unknown', 50);
    await event('unknown', 5);
    await event('sending', 90);
    await event('unknown', 60, {}, 'voiding');
    await storeFor(tenantId).noteInconclusive(older, 'looked at');

    const listed = await storeFor(tenantId).unresolvedCancellations(minutesAgo(15), 10);

    expect(listed.map(({ id, cdc }) => ({ id, cdc }))).toEqual([
      { id: newer, cdc: cdcs.get(newer) },
      { id: older, cdc: cdcs.get(older) },
    ]);
    expect(listed[0]).toMatchObject({ sentAt: minutesAgo(50), missedAt: null });
  });

  it('lists an unknown nomination too, with its kind, so a lost answer does not block the document forever', async () => {
    const nomination = await event('unknown', 60, {}, 'nomination');
    const cancellation = await event('unknown', 59);

    const listed = await storeFor(tenantId).unresolvedCancellations(minutesAgo(15), 10);

    expect(listed.map(({ id, kind }) => ({ id, kind }))).toEqual([
      { id: nomination, kind: 'nomination' },
      { id: cancellation, kind: 'cancellation' },
    ]);
  });

  it('claims what it lists: another worker, while the claim lasts, gets none of the same events', async () => {
    const id = await event('unknown', 60);
    const leased = createDrizzleEventRecoveryStore({
      db: handle.db,
      tenantId,
      now: () => NOW,
      claimLeaseMs: 5 * 60_000,
    });

    expect(
      (await storeFor(tenantId).unresolvedCancellations(minutesAgo(15), 10)).map((e) => e.id),
    ).toEqual([id]);
    expect(await leased.unresolvedCancellations(minutesAgo(15), 10)).toEqual([]);
  });

  it('remembers the first absence with its time, and stops listing a held event', async () => {
    const missed = await event('unknown', 60);
    const held = await event('unknown', 60);
    const store = storeFor(tenantId);

    await store.noteMissing(missed, 'absent, to confirm');
    await store.hold(held, 'unresolved past the window');

    expect(await read(missed)).toMatchObject({
      status: 'unknown',
      responseCode: 'LOC-MISS',
      respondedAt: NOW,
    });
    expect(await read(held)).toMatchObject({ status: 'unknown', responseCode: 'LOC-HOLD' });
    const listed = await store.unresolvedCancellations(minutesAgo(15), 10);
    expect(listed).toEqual([expect.objectContaining({ id: missed, missedAt: NOW })]);
  });

  it('keeps the first absence time when a later query is only inconclusive', async () => {
    const id = await event('unknown', 60);
    const store = storeFor(tenantId);
    await store.noteMissing(id, 'absent');

    await store.noteInconclusive(id, 'query failed');

    expect(await read(id)).toMatchObject({ responseCode: 'LOC-MISS', respondedAt: NOW });
  });

  it('notes an inconclusive query on the event, which stays unknown', async () => {
    const id = await event('unknown', 60);

    await storeFor(tenantId).noteInconclusive(id, 'SIFEN answered 0420 to the document query');

    expect(await read(id)).toMatchObject({
      status: 'unknown',
      responseMessage: 'SIFEN answered 0420 to the document query',
    });
  });

  it('settles an unknown event through record, with the real answer', async () => {
    const id = await event('unknown', 60);

    await storeFor(tenantId).record(
      new Map([[id, { status: 'approved', code: '0600', message: 'found by querying' }]]),
    );

    expect(await read(id)).toMatchObject({
      status: 'approved',
      responseCode: '0600',
      respondedAt: NOW,
    });
  });
});
