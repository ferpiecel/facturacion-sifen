import { eq } from 'drizzle-orm';
import {
  createPgliteDatabase,
  documentEmails,
  tenants,
  withTenantTransaction,
  type DatabaseHandle,
} from '@sifen/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { seedDocuments } from '../../../../test/support/document-seed.js';
import { createDrizzleDocumentEmailStore } from './drizzle-document-email-store.js';

const NOW = new Date('2026-10-01T12:00:00.000Z');
const MIN = 60_000;

/** Spec: HU-E11-02 (S4). DocumentEmailStore over `document_emails`, run as app_user under RLS. */
describe('DrizzleDocumentEmailStore', () => {
  let handle: DatabaseHandle;
  let tenantId: string;
  let otherTenantId: string;
  let docIds: string[];
  let otherDocId: string;
  let next: number;

  beforeEach(async () => {
    handle = createPgliteDatabase();
    await handle.migrate();
    const [a, b] = await handle.db
      .insert(tenants)
      .values([{ name: 'Acme SA' }, { name: 'B' }])
      .returning();
    [tenantId, otherTenantId] = [a.id, b.id];
    next = 0;
    docIds = (await seedDocuments(handle.db, tenantId, ['approved', 'approved', 'approved'])).map(
      (d) => d.id,
    );
    [otherDocId] = (await seedDocuments(handle.db, otherTenantId, ['approved'])).map((d) => d.id);
  });
  afterEach(async () => {
    await handle.close();
  });

  const store = (tenant = tenantId) =>
    createDrizzleDocumentEmailStore({ db: handle.db, tenantId: tenant });
  async function email(over: Partial<typeof documentEmails.$inferInsert> = {}, tenant = tenantId) {
    const documentId = tenant === tenantId ? docIds[next++] : otherDocId;
    const [row] = await handle.db
      .insert(documentEmails)
      .values({
        tenantId: tenant,
        documentId,
        recipient: 'cliente@example.com',
        nextAttemptAt: new Date(NOW.getTime() - MIN),
        ...over,
      })
      .returning();
    return row;
  }
  const read = (id: string) =>
    withTenantTransaction(handle.db, tenantId, (tx) =>
      tx.select().from(documentEmails).where(eq(documentEmails.id, id)),
    ).then((rows) => rows[0]);

  it('claims due emails oldest first with the tenant name, and leases them', async () => {
    const late = await email({ nextAttemptAt: new Date(NOW.getTime() - MIN) });
    const early = await email({
      nextAttemptAt: new Date(NOW.getTime() - 5 * MIN),
      status: 'failed',
      attemptCount: 2,
    });
    await email({ nextAttemptAt: new Date(NOW.getTime() + MIN) });
    await email({}, otherTenantId);
    const claimed = await store().claimDue(NOW, 10, 5 * MIN);
    expect(claimed.map((c) => c.id)).toEqual([early.id, late.id]);
    expect(claimed[0]).toMatchObject({
      tenantId,
      documentId: early.documentId,
      recipient: 'cliente@example.com',
      attemptCount: 3,
      tenantName: 'Acme SA',
    });
    expect((await read(early.id)).attemptCount).toBe(3);
    expect((await read(late.id)).nextAttemptAt).toEqual(new Date(NOW.getTime() + 5 * MIN));
    expect(await store().claimDue(NOW, 10, 5 * MIN)).toEqual([]);
  });

  it('counts every claim as an attempt, so a stale worker cannot overwrite the newer claim', async () => {
    const row = await email();
    const [first] = await store().claimDue(NOW, 10, MIN);
    expect(first.attemptCount).toBe(1);
    const later = new Date(NOW.getTime() + 2 * MIN);
    const [second] = await store().claimDue(later, 10, MIN);
    expect(second.attemptCount).toBe(2);
    const outcome = (attemptCount: number) => ({
      status: 'sent' as const,
      attemptCount,
      lastAttemptAt: later,
      nextAttemptAt: null,
      sentAt: later,
      lastError: null,
    });
    await expect(store().record(row.id, outcome(first.attemptCount))).rejects.toThrow(/not due/);
    await store().record(row.id, outcome(second.attemptCount));
    expect(await read(row.id)).toMatchObject({ status: 'sent', attemptCount: 2 });
  });

  it('records a sent outcome', async () => {
    const row = await email({ attemptCount: 1 });
    await store().record(row.id, {
      status: 'sent',
      attemptCount: 1,
      lastAttemptAt: NOW,
      nextAttemptAt: null,
      sentAt: NOW,
      lastError: null,
    });
    expect(await read(row.id)).toMatchObject({
      status: 'sent',
      attemptCount: 1,
      sentAt: NOW,
      nextAttemptAt: null,
    });
  });

  it('rejects an outcome for a row that moved on since the claim', async () => {
    const row = await email({ attemptCount: 3 });
    await expect(
      store().record(row.id, {
        status: 'dead',
        attemptCount: 2,
        lastAttemptAt: NOW,
        nextAttemptAt: null,
        sentAt: null,
        lastError: 'x',
      }),
    ).rejects.toThrow(/not due/);
  });
});
