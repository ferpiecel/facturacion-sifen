import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  auditLog,
  createPgliteDatabase,
  issuerEvents,
  tenants,
  withTenantTransaction,
  type DatabaseHandle,
} from '@sifen/db';
import {
  acceptInvoiceWithStatus,
  seedIssuer,
} from '../../../../test/support/credit-note-fixture.js';
import { createVoidNumbers } from '../application/void-numbers.js';
import { createDrizzleVoidingUnitOfWork } from './drizzle-voiding-unit-of-work.js';

/** Spec: HU-E8-03. The voiding command against a real (pglite) database. */
describe('VoidNumbers with the Drizzle unit of work', () => {
  let handle: DatabaseHandle;
  let tenantId: string;
  let otherTenantId: string;
  let keySeq = 0;
  /** Document ids by number: 1 approved, 2 rejected, 3 approved. */
  const ids: string[] = [];

  const voidNumbers = () =>
    createVoidNumbers({ unitOfWork: createDrizzleVoidingUnitOfWork(handle.db) });
  const request = (overrides: Record<string, unknown> = {}, tenant = tenantId) => ({
    tenantId: tenant,
    actor: { type: 'api_key', id: 'key-1' } as const,
    body: {
      timbrado: '22222222',
      establishment: '001',
      expeditionPoint: '002',
      type: 1,
      from: 2,
      to: 2,
      reason: 'Numero rechazado y no se reutiliza',
      ...overrides,
    },
    idempotencyKey: `void-${String(++keySeq)}`,
  });
  const rulesOf = async (work: Promise<unknown>) => {
    const error = (await work.then(
      () => undefined,
      (e: unknown) => e,
    )) as { errors?: { rule: string }[] } | undefined;
    return error?.errors?.map((e) => e.rule);
  };
  const events = () =>
    withTenantTransaction(handle.db, tenantId, (tx) => tx.select().from(issuerEvents));

  beforeEach(async () => {
    handle = createPgliteDatabase();
    await handle.migrate();
    const [a, b] = await handle.db
      .insert(tenants)
      .values([{ name: 'A' }, { name: 'B' }])
      .returning();
    tenantId = a.id;
    otherTenantId = b.id;
    await seedIssuer(handle.db, tenantId);
    await seedIssuer(handle.db, otherTenantId);
    ids.length = 0;
    for (const status of ['approved', 'rejected', 'approved']) {
      const fe = await acceptInvoiceWithStatus(
        handle.db,
        tenantId,
        `fe-${String(++keySeq)}`,
        status,
      );
      ids.push(fe.documentId);
    }
  });

  afterEach(async () => {
    await handle.close();
  });

  it('stores a pending voiding with its range and no document, and audits it', async () => {
    const result = await voidNumbers()(request());
    const [event] = await events();
    expect(event).toMatchObject({
      id: result.eventId,
      kind: 'voiding',
      documentId: null,
      status: 'pending',
      environment: 'test',
      voidRange: {
        timbrado: '22222222',
        establishment: '001',
        point: '002',
        from: 2,
        to: 2,
        type: 1,
      },
    });
    const audits = await withTenantTransaction(handle.db, tenantId, (tx) =>
      tx.select().from(auditLog).where(eq(auditLog.action, 'numbering.voiding_requested')),
    );
    expect(audits).toHaveLength(1);
  });

  it('is idempotent by key and stores one event', async () => {
    const first = request();
    const a = await voidNumbers()(first);
    expect(await voidNumbers()(first)).toEqual(a);
    expect(await events()).toHaveLength(1);
  });

  it('refuses a range with an approved document (4065) and burns no event id', async () => {
    expect(await rulesOf(voidNumbers()(request({ from: 1, to: 3 })))).toEqual([
      'range-has-documents',
    ]);
    expect(await events()).toHaveLength(0);
  });

  it('refuses numbers beyond the last one issued', async () => {
    expect(await rulesOf(voidNumbers()(request({ from: 4, to: 4 })))).toEqual([
      'range-beyond-issued-numbers',
    ]);
    expect(await rulesOf(voidNumbers()(request({ type: 5, from: 1, to: 1 })))).toEqual([
      'range-beyond-issued-numbers',
    ]);
  });

  it('refuses a second voiding of the same number while the first is open', async () => {
    await voidNumbers()(request());
    expect(await rulesOf(voidNumbers()(request({ from: 2, to: 2 })))).toEqual([
      'range-overlaps-voided',
    ]);
  });

  it('refuses a timbrado, establishment or point that is not the tenant`s', async () => {
    expect(await rulesOf(voidNumbers()(request({ timbrado: '99999999' })))).toEqual([
      'unknown-timbrado',
    ]);
    expect(await rulesOf(voidNumbers()(request({ establishment: '009' })))).toEqual([
      'unknown-establishment',
    ]);
    expect(await rulesOf(voidNumbers()(request({ expeditionPoint: '009' })))).toEqual([
      'unknown-expedition-point',
    ]);
  });

  it('never sees the numbers of another tenant', async () => {
    expect(await rulesOf(voidNumbers()(request({}, otherTenantId)))).toEqual([
      'range-beyond-issued-numbers',
    ]);
  });
});
