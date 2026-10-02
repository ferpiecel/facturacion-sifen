import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
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

  const store = () => createDrizzleTransmissionCycleStore({ db: handle.db, tenantId });

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
    const complete = await addLote(tenantId, 'pending', [
      await addDocument(tenantId, 'queued', 1),
    ]);
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
});
