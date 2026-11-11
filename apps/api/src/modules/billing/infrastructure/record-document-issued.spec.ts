import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createPgliteDatabase,
  tenants,
  usageCounters,
  withTenantTransaction,
  type DatabaseHandle,
} from '@sifen/db';
import { recordDocumentIssued } from './record-document-issued.js';

/** Spec: HU-E15-02. One atomic upsert per issued document, in the caller's tenant transaction. */
describe('recordDocumentIssued', () => {
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
    [tenantId, otherTenantId] = [a.id, b.id];
  });
  afterEach(async () => {
    await handle.close();
  });

  const record = (tenant: string, at: string) =>
    withTenantTransaction(handle.db, tenant, (tx) =>
      recordDocumentIssued(tx, { tenantId: tenant, at: new Date(at) }),
    );
  const counters = () =>
    handle.db
      .select()
      .from(usageCounters)
      .then((rows) =>
        rows.map((r) => [r.tenantId === tenantId ? 'A' : 'B', r.period, r.documentsIssued]).sort(),
      );

  it('creates the period row on the first document and increments it afterwards', async () => {
    await record(tenantId, '2026-10-05T12:00:00Z');
    await record(tenantId, '2026-10-20T12:00:00Z');
    expect(await counters()).toEqual([['A', '2026-10-01', 2]]);
  });

  it('keeps one row per tenant and Paraguay month', async () => {
    await record(tenantId, '2026-10-31T12:00:00Z');
    await record(tenantId, '2026-11-01T02:00:00Z');
    await record(tenantId, '2026-11-01T03:00:00Z');
    await record(otherTenantId, '2026-11-02T12:00:00Z');
    expect(await counters()).toEqual([
      ['A', '2026-10-01', 2],
      ['A', '2026-11-01', 1],
      ['B', '2026-11-01', 1],
    ]);
  });

  it('does not lose increments under concurrent writers', async () => {
    await Promise.all(Array.from({ length: 15 }, () => record(tenantId, '2026-10-05T12:00:00Z')));
    expect(await counters()).toEqual([['A', '2026-10-01', 15]]);
  });

  it('rolls back with the caller transaction', async () => {
    await expect(
      withTenantTransaction(handle.db, tenantId, async (tx) => {
        await recordDocumentIssued(tx, { tenantId, at: new Date('2026-10-05T12:00:00Z') });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await counters()).toEqual([]);
  });
});
