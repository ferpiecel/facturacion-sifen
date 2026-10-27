import { afterEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import type { DatabaseHandle } from '../src/client.js';
import { issuerEvents } from '../src/schema.js';
import { withTenantTransaction } from '../src/tenant-transaction.js';
import { RANGE, SIGNED_XML, causeOf, seedIssuerEvents } from './support/issuer-events-fixture.js';

/** Spec: HU-E8-04 (DB part, ADR-0020). Issuer events: one table, typed by `kind`, isolated per tenant. */
describe('issuer_events', () => {
  let handle: DatabaseHandle | undefined;

  afterEach(async () => {
    await handle?.close();
    handle = undefined;
  });

  async function seed() {
    const seeded = await seedIssuerEvents();
    handle = seeded.handle;
    return seeded;
  }

  it('stores a cancellation as pending, unsigned and unsent', async () => {
    const { db, cancel } = await seed();
    const [row] = await db.insert(issuerEvents).values(cancel()).returning();
    expect(row.status).toBe('pending');
    expect(row.signedXml).toBeNull();
    expect(row.batchDId).toBeNull();
    expect(row.responseCode).toBeNull();
    expect(row.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('stores a voiding with its range and no document', async () => {
    const { db, voiding } = await seed();
    const [row] = await db.insert(issuerEvents).values(voiding()).returning();
    expect(row.documentId).toBeNull();
    expect(row.voidRange).toEqual(RANGE);
  });

  it.each([
    ['an unknown kind', { kind: 'endorsement' }],
    ['a cancellation without a document', { documentId: null }],
    ['a cancellation with a range', { voidRange: RANGE }],
    ['a reason of 4 characters', { reason: 'nope' }],
    ['a reason of 501 characters', { reason: 'x'.repeat(501) }],
    ['an event id of 0', { eventId: 0n }],
    ['an event id over 10 digits', { eventId: 10_000_000_000n }],
  ])('refuses %s', async (_name, overrides) => {
    const { db, cancel } = await seed();
    await expect(db.insert(issuerEvents).values(cancel(overrides as never))).rejects.toThrow();
  });

  it.each([
    ['a voiding with a document', (docA: string) => ({ documentId: docA })],
    ['a voiding without a range', () => ({ voidRange: null })],
  ])('refuses %s', async (_name, build) => {
    const { db, docA, voiding } = await seed();
    await expect(db.insert(issuerEvents).values(voiding(build(docA)))).rejects.toThrow();
  });

  it('keeps the event id unique per tenant, so another tenant may reuse it', async () => {
    const { db, b, cancel, voiding } = await seed();
    await db.insert(issuerEvents).values(cancel());
    await expect(db.insert(issuerEvents).values(voiding({ eventId: 1n }))).rejects.toThrow();
    await db.insert(issuerEvents).values(voiding({ eventId: 1n, tenantId: b }));
  });

  it('allows one open event of a kind per document, and another after SIFEN refused it', async () => {
    const { db, cancel } = await seed();
    const [first] = await db.insert(issuerEvents).values(cancel()).returning();
    await expect(db.insert(issuerEvents).values(cancel({ eventId: 3n }))).rejects.toThrow();

    await db
      .update(issuerEvents)
      .set({ status: 'signed', signedXml: SIGNED_XML, signedAt: new Date() })
      .where(eq(issuerEvents.id, first.id));
    await db
      .update(issuerEvents)
      .set({ status: 'sending', batchDId: 7n, sendAttemptedAt: new Date() })
      .where(eq(issuerEvents.id, first.id));
    await db
      .update(issuerEvents)
      .set({
        status: 'rejected',
        responseCode: '4009',
        responseMessage: 'late',
        respondedAt: new Date(),
      })
      .where(eq(issuerEvents.id, first.id));

    await db.insert(issuerEvents).values(cancel({ eventId: 3n }));
  });

  describe('idempotency (HU-E8-02)', () => {
    const key = { idempotencyKey: 'k1', requestHash: 'a'.repeat(64) };

    it('stores the key and the hash of the request', async () => {
      const { db, cancel } = await seed();
      const [row] = await db
        .insert(issuerEvents)
        .values(cancel({ ...key }))
        .returning();
      expect(row.idempotencyKey).toBe('k1');
      expect(row.requestHash).toBe('a'.repeat(64));
    });

    it('keeps the key unique per tenant, and reusable by another one', async () => {
      const { db, a, b, cancel, voiding } = await seed();
      await db.insert(issuerEvents).values(cancel({ ...key }));
      expect(
        await causeOf(db.insert(issuerEvents).values(voiding({ eventId: 9n, ...key }))),
      ).toContain('issuer_events_idempotency_idx');
      await db.insert(issuerEvents).values(voiding({ eventId: 9n, tenantId: b, ...key }));
      expect(a).not.toBe(b);
    });

    it('takes the key and the hash together, or neither', async () => {
      const { db, cancel } = await seed();
      expect(
        await causeOf(db.insert(issuerEvents).values(cancel({ idempotencyKey: 'k1' }))),
      ).toContain('issuer_events_idempotency_pair');
    });

    it('never changes them afterwards', async () => {
      const { db, cancel } = await seed();
      await db.insert(issuerEvents).values(cancel({ ...key }));
      expect(await causeOf(db.update(issuerEvents).set({ idempotencyKey: 'k2' }))).toContain(
        'immutable',
      );
      expect(await causeOf(db.update(issuerEvents).set({ requestHash: 'b'.repeat(64) }))).toContain(
        'immutable',
      );
    });
  });

  describe('the answer of SIFEN', () => {
    const at = new Date('2026-10-16T12:00:00Z');
    const sent = { signedXml: SIGNED_XML, signedAt: at, batchDId: 5n, sendAttemptedAt: at };
    const answer = { responseCode: '0600', respondedAt: at };

    it.each([
      ['pending with an answer', { status: 'pending', ...answer }],
      [
        'signed with an answer',
        { status: 'signed', signedXml: SIGNED_XML, signedAt: at, ...answer },
      ],
      ['sending with only a response code', { status: 'sending', ...sent, responseCode: '4009' }],
      ['sending with only a response instant', { status: 'sending', ...sent, respondedAt: at }],
      ['approved without an answer', { status: 'approved', ...sent }],
      ['approved with only a response code', { status: 'approved', ...sent, responseCode: '0600' }],
      ['rejected with only a response instant', { status: 'rejected', ...sent, respondedAt: at }],
      ['unknown with only a response code', { status: 'unknown', ...sent, responseCode: '0' }],
    ])('refuses %s', async (_name, row) => {
      const { db, cancel } = await seed();
      await expect(db.insert(issuerEvents).values(cancel(row as never))).rejects.toThrow();
    });

    it.each([
      ['approved', { status: 'approved', ...sent, ...answer }],
      ['rejected', { status: 'rejected', ...sent, responseCode: '4009', respondedAt: at }],
      ['unknown without an answer', { status: 'unknown', ...sent }],
      ['unknown with a pair (the reason it is unknown)', { status: 'unknown', ...sent, ...answer }],
    ])('accepts %s', async (_name, row) => {
      const { db, cancel } = await seed();
      // The checks alone are under test here: the insert guard (0048) only lets an event start pending.
      await db.execute(sql`set session_replication_role = replica`);
      await db.insert(issuerEvents).values(cancel(row));
    });
  });

  describe('tenant isolation', () => {
    it('isolates reads and writes by tenant through RLS', async () => {
      const { db, a, b, cancel } = await seed();
      await db.insert(issuerEvents).values(cancel());

      const seenByA = await withTenantTransaction(db, a, (tx) => tx.select().from(issuerEvents));
      const seenByB = await withTenantTransaction(db, b, (tx) => tx.select().from(issuerEvents));
      expect(seenByA).toHaveLength(1);
      expect(seenByB).toHaveLength(0);
    });

    it('refuses a write for another tenant and a document of another tenant', async () => {
      const { db, a, b, docB, cancel } = await seed();
      await expect(
        withTenantTransaction(db, b, (tx) =>
          tx.insert(issuerEvents).values(cancel({ tenantId: a })),
        ),
      ).rejects.toThrow();
      await expect(db.insert(issuerEvents).values(cancel({ documentId: docB }))).rejects.toThrow();
    });

    it('never lets the application role delete an event', async () => {
      const { db, a, cancel } = await seed();
      await db.insert(issuerEvents).values(cancel());
      await expect(
        withTenantTransaction(db, a, (tx) => tx.execute(sql`delete from issuer_events`)),
      ).rejects.toThrow();
    });
  });
});
