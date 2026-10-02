import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  createPgliteDatabase,
  lotes,
  tenants,
  withTenantTransaction,
  type DatabaseHandle,
} from '@sifen/db';
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

  const storeFor = (tenant: string) =>
    createDrizzleLoteDispatchStore({ db: handle.db, tenantId: tenant, now: () => NOW });
  const readLote = () =>
    withTenantTransaction(handle.db, tenantId, (tx) =>
      tx.select().from(lotes).where(eq(lotes.id, loteId)),
    ).then((rows) => rows[0]);

  it('claims a pending lote once', async () => {
    const store = storeFor(tenantId);
    expect(await store.claim(loteId)).toBe(true);
    expect((await readLote()).status).toBe('sending');
    expect(await store.claim(loteId)).toBe(false);
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
});
