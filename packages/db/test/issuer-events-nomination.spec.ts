import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { DatabaseHandle } from '../src/client.js';
import { issuerEvents } from '../src/schema.js';
import { causeOf, seedIssuerEvents } from './support/issuer-events-fixture.js';

const NOMINATION = {
  kind: 'non-taxpayer',
  name: 'Juan Perez',
  documentType: 1,
  documentNumber: '1234567',
};

/** Spec: HU-E8-05 (DB part). A nomination stores the receiver it names, once, on the event. */
describe('issuer_events nomination', () => {
  let handle: DatabaseHandle | undefined;

  afterEach(async () => {
    await handle?.close();
    handle = undefined;
  });

  async function seed() {
    const seeded = await seedIssuerEvents();
    handle = seeded.handle;
    const nominate = (overrides: Partial<typeof issuerEvents.$inferInsert> = {}) =>
      seeded.cancel({ kind: 'nomination', nomination: NOMINATION, eventId: 5n, ...overrides });
    return { ...seeded, nominate };
  }

  it('stores a nomination with its receiver and its document', async () => {
    const { db, nominate } = await seed();
    const [row] = await db.insert(issuerEvents).values(nominate()).returning();
    expect(row.nomination).toEqual(NOMINATION);
    expect(row.status).toBe('pending');
  });

  it.each([
    ['a nomination without a receiver', { nomination: null }],
    ['a nomination without a document', { documentId: null }],
  ])('refuses %s', async (_name, overrides) => {
    const { db, nominate } = await seed();
    await expect(db.insert(issuerEvents).values(nominate(overrides as never))).rejects.toThrow();
  });

  it('refuses a cancellation that carries a nominated receiver', async () => {
    const { db, cancel } = await seed();
    await expect(
      db.insert(issuerEvents).values(cancel({ nomination: NOMINATION })),
    ).rejects.toThrow();
  });

  it('allows one open nomination per document', async () => {
    const { db, nominate } = await seed();
    await db.insert(issuerEvents).values(nominate());
    await expect(db.insert(issuerEvents).values(nominate({ eventId: 6n }))).rejects.toThrow();
  });

  it('keeps the nominated receiver immutable', async () => {
    const { db, nominate } = await seed();
    const [row] = await db.insert(issuerEvents).values(nominate()).returning();
    const cause = await causeOf(
      db
        .update(issuerEvents)
        .set({ nomination: { ...NOMINATION, name: 'Otro Nombre' } })
        .where(eq(issuerEvents.id, row.id)),
    );
    expect(cause).toContain('issuer_events');
  });
});
