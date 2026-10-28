import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { DatabaseHandle } from '../src/client.js';
import { issuerEvents } from '../src/schema.js';
import { causeOf, seedIssuerEvents } from './support/issuer-events-fixture.js';

const FOREIGN_CDC = '01800695631001001000000112026100111234567891';
const DATA = { issuedAt: '2026-10-01T10:00:00' };

/** Spec: HU-E9-02 (DB part, migration 0066). A receiver event is corrected by one other event, once. */
describe('issuer_events: corrections of receiver events', () => {
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
    const at = new Date('2026-10-16T12:00:00Z');
    const approve = async (id: string) => {
      await seeded.db
        .update(issuerEvents)
        .set({ status: 'signed', signedXml: '<g/>', signedAt: at })
        .where(eq(issuerEvents.id, id));
      await seeded.db
        .update(issuerEvents)
        .set({ status: 'sending', batchDId: 5n, sendAttemptedAt: at })
        .where(eq(issuerEvents.id, id));
      await seeded.db
        .update(issuerEvents)
        .set({ status: 'approved', responseCode: '0600', respondedAt: at })
        .where(eq(issuerEvents.id, id));
    };
    const original = async (overrides: Partial<typeof issuerEvents.$inferInsert> = {}) => {
      const [row] = await seeded.db.insert(issuerEvents).values(receiver(overrides)).returning();
      await approve(row.id);
      return row;
    };
    const correction = (
      of: string,
      overrides: Partial<typeof issuerEvents.$inferInsert> = {},
    ): typeof issuerEvents.$inferInsert =>
      receiver({
        kind: 'disconformity',
        reason: 'Mercadería dañada',
        receiverData: DATA,
        correctsEventId: of,
        correctionReason: 'Registré la conformidad por equivocación',
        ...overrides,
      });
    return { ...seeded, receiver, original, correction, approve };
  }

  it('stores a correction that points at an approved event of the same CDC, with its justification', async () => {
    const { db, original, correction } = await seed();
    const first = await original();

    const [row] = await db.insert(issuerEvents).values(correction(first.id)).returning();

    expect(row).toMatchObject({
      correctsEventId: first.id,
      correctionReason: 'Registré la conformidad por equivocación',
      status: 'pending',
    });
  });

  it('allows one correction per event, and another after SIFEN refused the first', async () => {
    const { db, original, correction } = await seed();
    const first = await original();
    const [attempt] = await db.insert(issuerEvents).values(correction(first.id)).returning();

    expect(
      await causeOf(
        db.insert(issuerEvents).values(
          correction(first.id, {
            kind: 'unawareness',
            reason: 'No la solicité',
            receiverData: { ...DATA, receivedAt: '2026-10-02T09:00:00' },
          }),
        ),
      ),
    ).toContain('issuer_events_correction_idx');

    await db
      .update(issuerEvents)
      .set({ status: 'signed', signedXml: '<g/>', signedAt: new Date() })
      .where(eq(issuerEvents.id, attempt.id));
    await db
      .update(issuerEvents)
      .set({ status: 'rejected', responseCode: 'LOC-XSD', respondedAt: new Date() })
      .where(eq(issuerEvents.id, attempt.id));
    await db.insert(issuerEvents).values(correction(first.id));
  });

  it.each([
    [
      'the justification missing',
      (id: string) => ({ correctsEventId: id, correctionReason: null }),
    ],
    [
      'a justification without an event',
      () => ({ correctsEventId: null, correctionReason: 'Por equivocación' }),
    ],
    [
      'a justification of 4 characters',
      (id: string) => ({ correctsEventId: id, correctionReason: 'nope' }),
    ],
  ])('refuses %s', async (_name, change) => {
    const { db, original, correction } = await seed();
    const first = await original();
    await expect(
      db.insert(issuerEvents).values(correction(first.id, change(first.id))),
    ).rejects.toThrow();
  });

  it('refuses a correction of an event that is not approved, of another CDC, of another tenant, of a correction, or of an issuer event', async () => {
    const { db, b, receiver, original, correction, cancel } = await seed();
    const pending = await db
      .insert(issuerEvents)
      .values(receiver({ kind: 'disconformity', reason: 'Mercadería dañada', receiverData: DATA }))
      .returning();
    const otherCdc = await original({ targetCdc: '9'.repeat(44) });
    const foreign = await original({ tenantId: b });
    const [issuerEvent] = await db
      .insert(issuerEvents)
      .values(cancel({ eventId: 500n }))
      .returning();
    const guard = (id: string, overrides = {}) =>
      causeOf(db.insert(issuerEvents).values(correction(id, { eventId: 900n, ...overrides })));

    expect(await guard(pending[0].id)).toContain('approved');
    expect(await guard(otherCdc.id)).toContain('same CDC');
    expect(await guard(foreign.id)).toContain('same tenant');
    expect(await guard(issuerEvent.id)).toContain('receiver');
  });

  it('refuses a correction of a correction', async () => {
    const { db, correction, original, approve } = await seed();
    const first = await original();
    const [fix] = await db.insert(issuerEvents).values(correction(first.id)).returning();
    await approve(fix.id);

    expect(
      await causeOf(
        db.insert(issuerEvents).values(
          correction(fix.id, {
            kind: 'conformity',
            reason: null,
            receiverData: { ...DATA, conformityType: 'total' },
            eventId: 901n,
          }),
        ),
      ),
    ).toContain('correction');
  });

  it('never changes the corrected event or the justification afterwards', async () => {
    const { db, original, correction } = await seed();
    const first = await original();
    await db.insert(issuerEvents).values(correction(first.id));

    expect(
      await causeOf(db.update(issuerEvents).set({ correctionReason: 'Otra justificación' })),
    ).toContain('immutable');
  });
});
