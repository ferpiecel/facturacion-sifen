import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import {
  createPgliteDatabase,
  documents,
  loteDocuments,
  lotes,
  tenantEstablishments,
  tenantExpeditionPoints,
  tenantFiscalProfiles,
  tenants,
  tenantTimbrados,
  type DatabaseHandle,
} from '@sifen/db';
import { createDrizzleTransmissionCycleStore } from './drizzle-transmission-cycle-store.js';

const at = (minutes: number) => new Date(Date.UTC(2026, 9, 2, 12, minutes));

/** Spec: HU-E6-02 (S5b). The cycle's work queries over documents, lotes and the dId sequence, under RLS. */
describe('DrizzleTransmissionCycleStore', () => {
  let handle: DatabaseHandle;
  let tenantId: string;
  let otherTenantId: string;
  let n = 0;
  const ids: Record<string, string> = {};

  async function seedTenant(tenant: string, withProfile: boolean) {
    const { db } = handle;
    if (withProfile) {
      await db.insert(tenantFiscalProfiles).values({
        tenantId: tenant,
        rucBase: '80000001',
        rucDv: 3,
        legalName: 'Empresa Real SA',
        taxpayerType: 'persona_juridica',
        regimeCode: '8',
      });
    }
    const [est] = await db
      .insert(tenantEstablishments)
      .values({
        tenantId: tenant,
        code: '001',
        address: 'Calle',
        houseNumber: '1',
        departmentCode: '11',
        districtCode: '145',
        districtDescription: 'X',
        cityCode: '3432',
        cityDescription: 'X',
      })
      .returning();
    const [point] = await db
      .insert(tenantExpeditionPoints)
      .values({ tenantId: tenant, establishmentId: est.id, code: '001' })
      .returning();
    const [timbrado] = await db
      .insert(tenantTimbrados)
      .values({ tenantId: tenant, number: '12345678', validFrom: '2024-01-01' })
      .returning();
    ids[tenant] = JSON.stringify({ est: est.id, point: point.id, timbrado: timbrado.id });
  }

  async function addDocument(
    tenant: string,
    status: string,
    minutes: number,
    environment: 'test' | 'production' = 'test',
  ) {
    n += 1;
    const ref = JSON.parse(ids[tenant]) as Record<'est' | 'point' | 'timbrado', string>;
    const [row] = await handle.db
      .insert(documents)
      .values({
        tenantId: tenant,
        environment,
        timbradoId: ref.timbrado,
        establishmentId: ref.est,
        expeditionPointId: ref.point,
        documentType: 1,
        number: n,
        cdc: String(n).padStart(44, '0'),
        securityCode: '123456789',
        status,
        signedXml: status === 'accepted' ? null : `<DE n="${String(n)}"/>`,
        signedAt: status === 'accepted' ? null : at(0),
        issuedAt: at(0),
        totalAmount: '1000',
        payload: {},
        createdAt: at(minutes),
      })
      .returning();
    return row.id;
  }

  async function addLote(tenant: string, status: string, documentIds: string[], nextPoll?: Date) {
    const [lote] = await handle.db
      .insert(lotes)
      .values({
        tenantId: tenant,
        environment: 'test',
        documentType: 1,
        status,
        nextPollAt: nextPoll ?? null,
        createdAt: at(documentIds.length),
        updatedAt: at(documentIds.length),
      })
      .returning();
    await handle.db
      .insert(loteDocuments)
      .values(documentIds.map((documentId) => ({ tenantId: tenant, loteId: lote.id, documentId })));
    return lote.id;
  }

  beforeEach(async () => {
    n = 0;
    handle = createPgliteDatabase();
    await handle.migrate();
    const [a, b] = await handle.db
      .insert(tenants)
      .values([{ name: 'A' }, { name: 'B' }])
      .returning();
    tenantId = a.id;
    otherTenantId = b.id;
    await seedTenant(tenantId, true);
    await seedTenant(otherTenantId, true);
  });

  afterEach(async () => {
    await handle.close();
  });

  const store = () =>
    createDrizzleTransmissionCycleStore({ db: handle.db, tenantId, now: () => at(30) });

  it('lists accepted documents of the current environment, oldest first and bounded', async () => {
    const late = await addDocument(tenantId, 'accepted', 5);
    const early = await addDocument(tenantId, 'accepted', 1);
    await addDocument(tenantId, 'signed', 0);
    await addDocument(otherTenantId, 'accepted', 0);

    expect(await store().acceptedDocumentIds(10)).toEqual([early, late]);
    expect(await store().acceptedDocumentIds(1)).toEqual([early]);

    // After an environment switch only the documents of the new one are worked on.
    await handle.db
      .update(tenants)
      .set({ environment: 'production' })
      .where(eq(tenants.id, tenantId));
    const current = await addDocument(tenantId, 'accepted', 9, 'production');
    expect(await store().acceptedDocumentIds(10)).toEqual([current]);
  });

  it('lists pending lotes with their signed documents and the issuer RUC', async () => {
    const d1 = await addDocument(tenantId, 'queued', 1);
    const d2 = await addDocument(tenantId, 'queued', 2);
    const pending = await addLote(tenantId, 'pending', [d1, d2]);
    await addLote(tenantId, 'sent', [await addDocument(tenantId, 'submitted', 3)]);
    await addLote(otherTenantId, 'pending', [await addDocument(otherTenantId, 'queued', 3)]);

    const found = await store().pendingLotes(10);

    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      loteId: pending,
      lote: { rucBase: '80000001', rucDv: 3, documentType: '01' },
    });
    expect(found[0].lote.documents.map((d) => d.xml)).toEqual(['<DE n="1"/>', '<DE n="2"/>']);
    expect(await store().pendingLotes(0)).toEqual([]);
  });

  it('lists sent lotes whose query time has come, most overdue first and bounded', async () => {
    const sent = async (minutes: number) =>
      addLote(tenantId, 'sent', [await addDocument(tenantId, 'submitted', minutes)], at(minutes));
    const second = await sent(20);
    const first = await sent(10);
    await sent(40);
    await addLote(tenantId, 'pending', [await addDocument(tenantId, 'queued', 5)], at(5));

    expect(await store().dueLoteIds(at(30), 10)).toEqual([first, second]);
    expect(await store().dueLoteIds(at(30), 1)).toEqual([first]);
  });

  it('lists recovery lotes not queried in the last 10 minutes, never-queried and oldest first', async () => {
    const recovery = async (minutes: number, lastPolledAt: Date | null) => {
      const id = await addLote(tenantId, 'recovery', [
        await addDocument(tenantId, 'submitted', minutes),
      ]);
      await handle.db.update(lotes).set({ lastPolledAt }).where(eq(lotes.id, id));
      return id;
    };
    const queriedLong = await recovery(1, at(5));
    const neverQueried = await recovery(2, null);
    await recovery(3, at(25));
    const queriedLonger = await recovery(4, at(0));
    await addLote(tenantId, 'sent', [await addDocument(tenantId, 'submitted', 5)], at(0));
    await addLote(otherTenantId, 'recovery', [await addDocument(otherTenantId, 'submitted', 6)]);

    expect(await store().recoverableLoteIds(at(30), 10)).toEqual([
      neverQueried,
      queriedLonger,
      queriedLong,
    ]);
    expect(await store().recoverableLoteIds(at(30), 1)).toEqual([neverQueried]);
    expect(await store().recoverableLoteIds(at(30), 0)).toEqual([]);
  });

  it('ignores lotes of an environment the tenant has left', async () => {
    await addLote(tenantId, 'pending', [await addDocument(tenantId, 'queued', 1)]);
    await addLote(tenantId, 'sent', [await addDocument(tenantId, 'submitted', 2)], at(1));
    expect(await store().pendingLotes(10)).toHaveLength(1);
    expect(await store().dueLoteIds(at(30), 10)).toHaveLength(1);

    await handle.db
      .update(tenants)
      .set({ environment: 'production' })
      .where(eq(tenants.id, tenantId));

    expect(await store().pendingLotes(10)).toEqual([]);
    expect(await store().dueLoteIds(at(30), 10)).toEqual([]);
  });

  it('skips a pending lote whose documents are not all signed instead of sending fewer', async () => {
    const complete = await addLote(tenantId, 'pending', [await addDocument(tenantId, 'queued', 1)]);
    await addLote(tenantId, 'pending', [
      await addDocument(tenantId, 'queued', 2),
      await addDocument(tenantId, 'accepted', 3),
    ]);

    const found = await store().pendingLotes(10);

    expect(found.map((p) => p.loteId)).toEqual([complete]);
  });

  it('reserves consecutive dIds per tenant', async () => {
    const mine = await Promise.all([store().nextRequestId(), store().nextRequestId()]);
    const theirs = createDrizzleTransmissionCycleStore({
      db: handle.db,
      tenantId: otherTenantId,
    });

    expect([...mine].sort()).toEqual([1n, 2n]);
    expect(await theirs.nextRequestId()).toBe(1n);
  });

  it('parks an accepted document: it leaves the signing batch and shows as held', async () => {
    const poison = await addDocument(tenantId, 'accepted', 1);
    const fine = await addDocument(tenantId, 'accepted', 2);
    const signed = await addDocument(tenantId, 'signed', 3);

    await store().holdDocument(poison, 'signing:CscNotConfiguredError');
    await store().holdDocument(signed, 'signing:CscNotConfiguredError');

    expect(await store().acceptedDocumentIds(10)).toEqual([fine]);
    expect(await store().heldDocuments(10)).toEqual([
      { documentId: poison, reason: 'signing:CscNotConfiguredError' },
    ]);
    expect(await store().heldDocuments(0)).toEqual([]);
  });

  it('lists every held document, whatever its status, for the operator', async () => {
    const exhausted = await addDocument(tenantId, 'queued', 1);
    await handle.db
      .update(documents)
      .set({ transmissionHold: 'transmission:attempts-exhausted' })
      .where(eq(documents.id, exhausted));
    await addDocument(otherTenantId, 'queued', 1);

    expect(await store().heldDocuments(10)).toEqual([
      { documentId: exhausted, reason: 'transmission:attempts-exhausted' },
    ]);
  });

  it('moves a deferred pending lote behind the others and counts the stale ones', async () => {
    const first = await addLote(tenantId, 'pending', [await addDocument(tenantId, 'queued', 1)]);
    const second = await addLote(tenantId, 'pending', [
      await addDocument(tenantId, 'queued', 2),
      await addDocument(tenantId, 'queued', 3),
    ]);

    await store().deferPendingLote(first);

    expect((await store().pendingLotes(10)).map((p) => p.loteId)).toEqual([second, first]);
    expect(await store().pendingOlderThan(at(2))).toBe(1);
    expect(await store().pendingOlderThan(at(5))).toBe(2);
    expect(await store().pendingOlderThan(at(0))).toBe(0);
  });

  it('sweeps only the lotes stuck in sending before the cutoff to unknown, for this tenant', async () => {
    const stuck = await addLote(tenantId, 'sending', [await addDocument(tenantId, 'queued', 1)]);
    const recent = await addLote(tenantId, 'sending', [
      await addDocument(tenantId, 'queued', 2),
      await addDocument(tenantId, 'queued', 3),
      await addDocument(tenantId, 'queued', 4),
    ]);
    const pending = await addLote(tenantId, 'pending', [await addDocument(tenantId, 'queued', 5)]);
    const theirs = await addLote(otherTenantId, 'sending', [
      await addDocument(otherTenantId, 'queued', 6),
    ]);
    const statusOf = async (id: string) =>
      (await handle.db.select().from(lotes).where(eq(lotes.id, id)))[0];

    expect(await store().sweepStaleSending(at(2), 100)).toBe(1);

    expect(await statusOf(stuck)).toMatchObject({ status: 'unknown' });
    expect((await statusOf(stuck)).responseMessage).toContain('no outcome');
    expect((await statusOf(recent)).status).toBe('sending');
    expect((await statusOf(pending)).status).toBe('pending');
    expect((await statusOf(theirs)).status).toBe('sending');
    expect(await store().sweepStaleSending(at(2), 100)).toBe(0);
  });

  it('lists unknown lotes and processed ones that still hold submitted documents for recovery', async () => {
    const unknown = await addLote(tenantId, 'unknown', [await addDocument(tenantId, 'queued', 1)]);
    const leftover = await addLote(tenantId, 'processed', [
      await addDocument(tenantId, 'approved', 2),
      await addDocument(tenantId, 'submitted', 3),
    ]);
    await addLote(tenantId, 'processed', [
      await addDocument(tenantId, 'approved', 4),
      await addDocument(tenantId, 'rejected', 5),
      await addDocument(tenantId, 'approved', 6),
    ]);
    await addLote(otherTenantId, 'unknown', [await addDocument(otherTenantId, 'queued', 7)]);

    expect([...(await store().recoverableLoteIds(at(30), 10))].sort()).toEqual(
      [unknown, leftover].sort(),
    );
  });

  it('does not list a processed lote whose submitted documents are all held', async () => {
    const heldDoc = await addDocument(tenantId, 'submitted', 1);
    await handle.db
      .update(documents)
      .set({ transmissionHold: 'recovery:0420-unresolved' })
      .where(eq(documents.id, heldDoc));
    await addLote(tenantId, 'processed', [heldDoc]);
    const open = await addLote(tenantId, 'processed', [
      await addDocument(tenantId, 'submitted', 2),
      await addDocument(tenantId, 'submitted', 3),
    ]);
    expect(await store().recoverableLoteIds(at(30), 10)).toEqual([open]);
  });

  it('sweeps strictly before the cutoff: a lote updated exactly at it is left alone', async () => {
    const lote = await addLote(tenantId, 'sending', [
      await addDocument(tenantId, 'queued', 1),
      await addDocument(tenantId, 'queued', 2),
    ]);
    expect(await store().sweepStaleSending(at(2), 100)).toBe(0);
    expect(await store().sweepStaleSending(new Date(at(2).getTime() + 1), 100)).toBe(1);
    expect((await handle.db.select().from(lotes).where(eq(lotes.id, lote)))[0].status).toBe(
      'unknown',
    );
  });

  it('sweeps at most `limit` lotes per call, oldest first, and the rest on the next one', async () => {
    const stuck: string[] = [];
    for (const n of [1, 2, 3]) {
      stuck.push(await addLote(tenantId, 'sending', [await addDocument(tenantId, 'queued', n)]));
    }
    expect(await store().sweepStaleSending(at(5), 2)).toBe(2);
    expect(await store().sweepStaleSending(at(5), 2)).toBe(1);
    expect(await store().sweepStaleSending(at(5), 2)).toBe(0);
    expect(await store().sweepStaleSending(at(5), 0)).toBe(0);
  });

  it('locks the lotes it sweeps and re-checks status and cutoff in the UPDATE itself', async () => {
    // A lote that records `sent` between the id selection and the UPDATE must not be forced to
    // `unknown` (and the sweep must not wait on it): concurrency cannot be interleaved on PGlite, so
    // this pins the shape of the statement that guarantees it.
    await addLote(tenantId, 'sending', [await addDocument(tenantId, 'queued', 1)]);
    const statements: string[] = [];
    const logged = drizzle((handle.db as unknown as { $client: never }).$client, {
      logger: { logQuery: (query) => statements.push(query) },
    });
    const spied = createDrizzleTransmissionCycleStore({
      db: logged as unknown as typeof handle.db,
      tenantId,
    });

    expect(await spied.sweepStaleSending(at(5), 10)).toBe(1);

    const update = statements.find((query) => /update "lotes"/i.test(query)) ?? '';
    expect(update).toMatch(/for update skip locked/i);
    expect(update.match(/"status" = \$/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(update.match(/"updated_at" < \$/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it('does not list a processed lote whose submitted documents are waiting to be resent or live in a newer lote', async () => {
    const waiting = await addDocument(tenantId, 'submitted', 1);
    const moved = await addDocument(tenantId, 'submitted', 2);
    const open = await addDocument(tenantId, 'submitted', 3);
    const lotWaiting = await addLote(tenantId, 'processed', [waiting]);
    const lotMoved = await addLote(tenantId, 'processed', [moved]);
    const lotOpen = await addLote(tenantId, 'processed', [open]);
    // `waiting` was queued again after its lote existed and no newer lote carries it yet.
    await handle.db
      .update(documents)
      .set({ status: 'queued', resentAt: new Date(Date.now() + 60_000), transmissionAttempts: 1 })
      .where(eq(documents.id, waiting));
    // `moved` was queued again (the door: its lote is processed), long before the newer lote that
    // now carries it was created: that newer lote is its own recoverable business.
    await handle.db
      .update(documents)
      .set({
        status: 'queued',
        resentAt: new Date(Date.now() - 3_600_000),
        transmissionAttempts: 1,
      })
      .where(eq(documents.id, moved));
    await handle.db.update(documents).set({ status: 'submitted' }).where(eq(documents.id, moved));
    const newer = await addLote(tenantId, 'sent', [moved], at(40));
    expect(newer).not.toBe(lotMoved);

    const ids = await store().recoverableLoteIds(at(30), 10);
    expect(ids).toContain(lotOpen);
    expect(ids).not.toContain(lotWaiting);
    expect(ids).not.toContain(lotMoved);
  });
});
