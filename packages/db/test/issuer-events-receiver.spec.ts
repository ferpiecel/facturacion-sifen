import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { DatabaseHandle } from '../src/client.js';
import { issuerEvents } from '../src/schema.js';
import { withTenantTransaction } from '../src/tenant-transaction.js';
import { causeOf, seedIssuerEvents } from './support/issuer-events-fixture.js';

const FOREIGN_CDC = '01800695631001001000000112026100111234567891';
const DATA = { issuedAt: '2026-10-01T10:00:00' };

/** Spec: HU-E9-01 (DB part, ADR-0020, migration 0065). Receiver events share issuer_events and point at a foreign CDC. */
describe('issuer_events: receiver events', () => {
  let handle: DatabaseHandle | undefined;

  afterEach(async () => {
    await handle?.close();
    handle = undefined;
  });

  async function seed() {
    const seeded = await seedIssuerEvents();
    handle = seeded.handle;
    let next = 100n;
    const receiver = (
      overrides: Partial<typeof issuerEvents.$inferInsert> = {},
    ): typeof issuerEvents.$inferInsert => ({
      tenantId: seeded.a,
      environment: 'test',
      kind: 'conformity',
      eventId: (next += 1n),
      targetCdc: FOREIGN_CDC,
      receiverData: { ...DATA, conformityType: 'total' },
      ...overrides,
    });
    return { ...seeded, receiver };
  }

  it('stores each kind of receiver event with its CDC, its data and no document', async () => {
    const { db, receiver } = await seed();
    const rows = await db
      .insert(issuerEvents)
      .values([
        receiver(),
        receiver({ kind: 'disconformity', reason: 'Mercadería dañada', receiverData: DATA }),
        receiver({ kind: 'unawareness', reason: 'No la solicité', receiverData: DATA }),
        receiver({ kind: 'receipt_notice', receiverData: { ...DATA, totalPyg: 1000 } }),
      ])
      .returning();
    expect(rows.map((r) => r.status)).toEqual(['pending', 'pending', 'pending', 'pending']);
    expect(rows.every((r) => r.documentId === null && r.targetCdc === FOREIGN_CDC)).toBe(true);
    expect(rows[0]?.reason).toBeNull();
  });

  it.each([
    ['without a CDC', { targetCdc: null }],
    ['with a CDC that is not 44 digits', { targetCdc: '123' }],
    ['without its data', { receiverData: null }],
    ['pointing at a document', (docA: string) => ({ documentId: docA })],
    ['conformity with a reason', { reason: 'no corresponde' }],
    ['disconformity without a reason', { kind: 'disconformity' }],
    ['disconformity with a reason of 4 characters', { kind: 'disconformity', reason: 'nope' }],
    ['unawareness without a reason', { kind: 'unawareness' }],
    ['receipt notice with a reason', { kind: 'receipt_notice', reason: 'no corresponde' }],
  ])('refuses a receiver event %s', async (_name, change) => {
    const { db, docA, receiver } = await seed();
    const overrides = typeof change === 'function' ? change(docA) : change;
    await expect(db.insert(issuerEvents).values(receiver(overrides as never))).rejects.toThrow();
  });

  it('refuses a CDC or receiver data on an issuer event, and an issuer event without its reason', async () => {
    const { db, cancel, voiding } = await seed();
    await expect(
      db.insert(issuerEvents).values(cancel({ targetCdc: FOREIGN_CDC })),
    ).rejects.toThrow();
    await expect(db.insert(issuerEvents).values(voiding({ receiverData: DATA }))).rejects.toThrow();
    await expect(db.insert(issuerEvents).values(cancel({ reason: null }))).rejects.toThrow();
  });

  it('allows one open event of a kind per CDC, but a partial and a total conformity together', async () => {
    const { db, a, receiver } = await seed();
    await db.insert(issuerEvents).values(receiver());
    expect(await causeOf(db.insert(issuerEvents).values(receiver()))).toContain(
      'issuer_events_receiver_open_idx',
    );
    await db.insert(issuerEvents).values(
      receiver({
        receiverData: {
          ...DATA,
          conformityType: 'partial',
          estimatedReceiptAt: '2026-10-05T00:00:00',
        },
      }),
    );
    const disconformity = receiver({
      kind: 'disconformity',
      reason: 'Mercadería dañada',
      receiverData: DATA,
    });
    await db.insert(issuerEvents).values(disconformity);
    await expect(
      db.insert(issuerEvents).values({ ...disconformity, eventId: 900n }),
    ).rejects.toThrow();
    expect(a).toBeDefined();
  });

  it('lets a refused event be requested again, and another tenant use the same CDC', async () => {
    const { db, b, receiver } = await seed();
    const [first] = await db.insert(issuerEvents).values(receiver()).returning();
    await db.insert(issuerEvents).values(receiver({ tenantId: b }));
    await db
      .update(issuerEvents)
      .set({ status: 'signed', signedXml: '<g/>', signedAt: new Date() })
      .where(eq(issuerEvents.id, first.id));
    await db
      .update(issuerEvents)
      .set({ status: 'rejected', responseCode: 'LOC-XSD', respondedAt: new Date() })
      .where(eq(issuerEvents.id, first.id));
    await db.insert(issuerEvents).values(receiver());
  });

  it('never changes the CDC or the data afterwards', async () => {
    const { db, receiver } = await seed();
    await db.insert(issuerEvents).values(receiver());
    expect(await causeOf(db.update(issuerEvents).set({ targetCdc: '9'.repeat(44) }))).toContain(
      'immutable',
    );
    expect(await causeOf(db.update(issuerEvents).set({ receiverData: DATA }))).toContain(
      'immutable',
    );
  });

  it('isolates receiver events by tenant through RLS', async () => {
    const { db, a, b, receiver } = await seed();
    await db.insert(issuerEvents).values(receiver());
    const seenByA = await withTenantTransaction(db, a, (tx) => tx.select().from(issuerEvents));
    const seenByB = await withTenantTransaction(db, b, (tx) => tx.select().from(issuerEvents));
    expect([seenByA.length, seenByB.length]).toEqual([1, 0]);
  });
});
