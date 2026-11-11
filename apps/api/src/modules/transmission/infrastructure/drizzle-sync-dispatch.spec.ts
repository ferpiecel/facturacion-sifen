import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  auditLog,
  createPgliteDatabase,
  documents,
  loteDocuments,
  lotes,
  tenantEstablishments,
  tenantExpeditionPoints,
  tenantFiscalProfiles,
  tenants,
  tenantTimbrados,
  withTenantTransaction,
  type DatabaseHandle,
} from '@sifen/db';
import { createDrizzleSyncDispatch } from './drizzle-sync-dispatch.js';

const NOW = new Date('2026-10-01T12:00:00.000Z');
const CDC = '01800695631001001000000112026010111234567891';

/** Spec: HU-E6-06. The sync opt-in lives on the fiscal profile; a sync answer settles lote and document. */
describe('DrizzleSyncDispatch', () => {
  let handle: DatabaseHandle;
  let tenantId: string;
  let loteId: string;

  beforeEach(async () => {
    handle = createPgliteDatabase();
    await handle.migrate();
    const { db } = handle;
    const [tenant] = await db.insert(tenants).values({ name: 'A' }).returning();
    tenantId = tenant.id;
    await db.insert(tenantFiscalProfiles).values({
      tenantId,
      rucBase: '80069563',
      rucDv: 1,
      legalName: 'Empresa SA',
      taxpayerType: 'persona_juridica',
      syncTransmission: true,
    });
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
    const [lote] = await db
      .insert(lotes)
      .values({ tenantId, environment: 'test', documentType: 1, status: 'sending' })
      .returning();
    loteId = lote.id;
    const [document] = await db
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
        status: 'queued',
        issuedAt: new Date('2026-01-01T12:00:00Z'),
        totalAmount: '110000',
        payload: {},
      })
      .returning();
    await db.insert(loteDocuments).values({ tenantId, loteId, documentId: document.id });
  });

  afterEach(async () => {
    await handle.close();
  });

  const sync = () => createDrizzleSyncDispatch({ db: handle.db, tenantId, now: () => NOW });
  const inTenant = <T>(fn: Parameters<typeof withTenantTransaction<T>>[2]) =>
    withTenantTransaction(handle.db, tenantId, fn);

  it('reports the flag of the fiscal profile', async () => {
    expect(await sync().isEnabled()).toBe(true);
    await handle.db.update(tenantFiscalProfiles).set({ syncTransmission: false });
    expect(await sync().isEnabled()).toBe(false);
  });

  it('is disabled for a tenant without a fiscal profile', async () => {
    await handle.db.delete(tenantFiscalProfiles);
    expect(await sync().isEnabled()).toBe(false);
  });

  it('clears the flag and audits it as the transmission worker', async () => {
    await sync().disable('1264: RUC no habilitado');
    expect(await sync().isEnabled()).toBe(false);
    const rows = await inTenant((tx) =>
      tx.select().from(auditLog).where(eq(auditLog.action, 'tenant.sync_transmission_disabled')),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorType: 'system',
      entityType: 'tenant',
      entityId: tenantId,
    });
  });

  it.each(['approved', 'rejected'] as const)(
    'settles the lote as processed and the document as %s',
    async (status) => {
      await sync().recordSettled(loteId, {
        cdc: CDC,
        status,
        messages: [{ code: '0260', message: 'ok' }],
      });
      const [lote] = await inTenant((tx) => tx.select().from(lotes).where(eq(lotes.id, loteId)));
      expect(lote.status).toBe('processed');
      const [doc] = await inTenant((tx) =>
        tx.select().from(documents).where(eq(documents.cdc, CDC)),
      );
      expect(doc.status).toBe(status);
      expect(doc.sifenMessages).toEqual([{ code: '0260', message: 'ok' }]);
    },
  );

  it('refuses to settle a lote that is no longer being sent', async () => {
    await handle.db.update(lotes).set({ status: 'pending' });
    await expect(
      sync().recordSettled(loteId, { cdc: CDC, status: 'approved', messages: [] }),
    ).rejects.toThrow(/not in sending/);
  });
});
