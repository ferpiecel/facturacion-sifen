import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { DatabaseHandle } from '../src/client.js';
import { issuerEvents, tenants } from '../src/schema.js';
import { SIGNED_XML, causeOf, seedIssuerEvents } from './support/issuer-events-fixture.js';

/** Spec: HU-E8-04 (DB part, ADR-0020). What the guard triggers of issuer_events allow. */
describe('issuer_events guards', () => {
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

  describe('signing and sending', () => {
    async function pendingRow() {
      const ctx = await seed();
      const [row] = await ctx.db.insert(issuerEvents).values(ctx.cancel()).returning();
      const sign = () =>
        ctx.db
          .update(issuerEvents)
          .set({ status: 'signed', signedXml: SIGNED_XML, signedAt: new Date() })
          .where(eq(issuerEvents.id, row.id));
      const send = () =>
        ctx.db
          .update(issuerEvents)
          .set({ status: 'sending', batchDId: 9n, sendAttemptedAt: new Date() })
          .where(eq(issuerEvents.id, row.id));
      const answer = (status: string, code: string) =>
        ctx.db
          .update(issuerEvents)
          .set({ status, responseCode: code, responseMessage: 'm', respondedAt: new Date() })
          .where(eq(issuerEvents.id, row.id));
      return { ...ctx, row, sign, send, answer };
    }

    it('walks pending, signed, sending and approved, stamping updated_at', async () => {
      const { db, row, sign, send, answer } = await pendingRow();
      await sign();
      await send();
      await answer('approved', '0600');
      const [done] = await db.select().from(issuerEvents).where(eq(issuerEvents.id, row.id));
      expect(done.status).toBe('approved');
      expect(done.signedXml).toBe(SIGNED_XML);
      expect(done.batchDId).toBe(9n);
      expect(done.updatedAt.getTime()).toBeGreaterThanOrEqual(row.updatedAt.getTime());
    });

    it('refuses a signed status without the XML, and the XML before signing', async () => {
      const { db, row } = await pendingRow();
      await expect(
        db.update(issuerEvents).set({ status: 'signed' }).where(eq(issuerEvents.id, row.id)),
      ).rejects.toThrow();
      await expect(
        db.update(issuerEvents).set({ signedXml: SIGNED_XML }).where(eq(issuerEvents.id, row.id)),
      ).rejects.toThrow();
    });

    it('makes the signed XML and its instant write-once', async () => {
      const { db, row, sign } = await pendingRow();
      await sign();
      const message = await causeOf(
        db.update(issuerEvents).set({ signedXml: '<other/>' }).where(eq(issuerEvents.id, row.id)),
      );
      expect(message).toContain('write-once');
    });

    it('refuses to skip a step or to leave a terminal status', async () => {
      const { db, row, sign, send, answer } = await pendingRow();
      expect(await causeOf(answer('approved', '0600'))).toContain('invalid status transition');
      await sign();
      expect(await causeOf(answer('approved', '0600'))).toContain('invalid status transition');
      await send();
      await answer('rejected', '4009');
      const message = await causeOf(
        db.update(issuerEvents).set({ status: 'approved' }).where(eq(issuerEvents.id, row.id)),
      );
      expect(message).toContain('invalid status transition');
    });

    it('lets an unanswered send be resolved later, and only that way', async () => {
      const { sign, send, answer } = await pendingRow();
      await sign();
      await send();
      await answer('unknown', '0');
      await answer('approved', '0600');
    });

    it('lets an unanswered send be refused later too', async () => {
      const { sign, send, answer } = await pendingRow();
      await sign();
      await send();
      await answer('unknown', '0');
      await answer('rejected', '4009');
    });

    it.each(['approved', 'rejected'])('freezes the answer once the event is %s', async (final) => {
      const { db, row, sign, send, answer } = await pendingRow();
      await sign();
      await send();
      await answer(final, final === 'approved' ? '0600' : '4009');
      for (const change of [
        { responseCode: '9999' },
        { responseMessage: 'changed' },
        { sifenProtocol: '1234567890' },
        { respondedAt: new Date('2030-01-01T00:00:00Z') },
      ]) {
        const message = await causeOf(
          db.update(issuerEvents).set(change).where(eq(issuerEvents.id, row.id)),
        );
        expect(message).toContain('an answered event is final');
      }
    });

    it('makes signed_at, batch_d_id and send_attempted_at write-once', async () => {
      const { db, row, sign, send } = await pendingRow();
      await sign();
      expect(
        await causeOf(
          db
            .update(issuerEvents)
            .set({ signedAt: new Date('2030-01-01T00:00:00Z') })
            .where(eq(issuerEvents.id, row.id)),
        ),
      ).toContain('write-once');
      await send();
      expect(
        await causeOf(
          db.update(issuerEvents).set({ batchDId: 10n }).where(eq(issuerEvents.id, row.id)),
        ),
      ).toContain('write-once');
      expect(
        await causeOf(
          db
            .update(issuerEvents)
            .set({ sendAttemptedAt: new Date('2030-01-01T00:00:00Z') })
            .where(eq(issuerEvents.id, row.id)),
        ),
      ).toContain('write-once');
    });

    it('moves updated_at forward on every update', async () => {
      const { db, row, sign, send } = await pendingRow();
      const read = async () =>
        (await db.select().from(issuerEvents).where(eq(issuerEvents.id, row.id)))[0].updatedAt;
      const stamps = [await read()];
      for (const step of [sign, send]) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        await step();
        stamps.push(await read());
      }
      expect(stamps[1].getTime()).toBeGreaterThan(stamps[0].getTime());
      expect(stamps[2].getTime()).toBeGreaterThan(stamps[1].getTime());
    });

    it('requires a response code for an answered event and a batch id for a sent one', async () => {
      const { db, row, sign } = await pendingRow();
      await sign();
      await expect(
        db
          .update(issuerEvents)
          .set({ status: 'sending', sendAttemptedAt: new Date() })
          .where(eq(issuerEvents.id, row.id)),
      ).rejects.toThrow();
    });

    it('freezes the identity of the event', async () => {
      const { db, row } = await pendingRow();
      for (const change of [
        { eventId: 99n },
        { reason: 'Otro motivo distinto' },
        { kind: 'voiding' },
        { documentId: null },
      ]) {
        await expect(
          db
            .update(issuerEvents)
            .set(change as never)
            .where(eq(issuerEvents.id, row.id)),
        ).rejects.toThrow();
      }
    });
  });

  it.each([
    [
      'sending',
      { signedXml: SIGNED_XML, signedAt: new Date(), batchDId: 1n, sendAttemptedAt: new Date() },
    ],
    [
      'approved',
      {
        signedXml: SIGNED_XML,
        signedAt: new Date(),
        batchDId: 1n,
        sendAttemptedAt: new Date(),
        responseCode: '0600',
        respondedAt: new Date(),
      },
    ],
    ['signed', { signedXml: SIGNED_XML, signedAt: new Date() }],
  ])('refuses to create an event already %s: it starts pending', async (status, fields) => {
    const { db, cancel } = await seed();
    const message = await causeOf(db.insert(issuerEvents).values(cancel({ status, ...fields })));
    expect(message).toContain('an event starts pending');
  });

  describe('local rejection of an event that was never sent', () => {
    const rejectLocally = (code: string) => ({
      status: 'rejected',
      responseCode: code,
      responseMessage: 'not valid',
      respondedAt: new Date(),
    });

    async function signedRow() {
      const ctx = await seed();
      const [row] = await ctx.db.insert(issuerEvents).values(ctx.cancel()).returning();
      await ctx.db
        .update(issuerEvents)
        .set({ status: 'signed', signedXml: SIGNED_XML, signedAt: new Date() })
        .where(eq(issuerEvents.id, row.id));
      return { ...ctx, row };
    }

    it('lets a signed event be rejected with a LOC- code and no batch id', async () => {
      const { db, row } = await signedRow();
      await db
        .update(issuerEvents)
        .set(rejectLocally('LOC-XSD'))
        .where(eq(issuerEvents.id, row.id));
      const [after] = await db.select().from(issuerEvents).where(eq(issuerEvents.id, row.id));
      expect(after).toMatchObject({ status: 'rejected', batchDId: null, sendAttemptedAt: null });
    });

    it('refuses the same without a LOC- code: a signed event cannot be rejected as if SIFEN had', async () => {
      const { db, row } = await signedRow();
      await expect(
        db.update(issuerEvents).set(rejectLocally('4009')).where(eq(issuerEvents.id, row.id)),
      ).rejects.toThrow();
    });

    it('refuses a sent event without a batch id even with a LOC- code', async () => {
      const { db, row } = await signedRow();
      await expect(
        db
          .update(issuerEvents)
          .set({ ...rejectLocally('LOC-XSD'), status: 'sending' })
          .where(eq(issuerEvents.id, row.id)),
      ).rejects.toThrow();
    });
  });

  it('refuses a pending event created with signing or send fields', async () => {
    const { db, cancel } = await seed();
    await expect(
      db.insert(issuerEvents).values(cancel({ signedXml: SIGNED_XML, signedAt: new Date() })),
    ).rejects.toThrow();
    await expect(
      db.insert(issuerEvents).values(cancel({ batchDId: 1n, sendAttemptedAt: new Date() })),
    ).rejects.toThrow();
  });

  it('refuses an event outside the tenant environment, and a document of another environment', async () => {
    const { db, a, cancel, voiding } = await seed();
    expect(
      await causeOf(db.insert(issuerEvents).values(voiding({ environment: 'production' }))),
    ).toContain("tenant's current environment");

    await db.update(tenants).set({ environment: 'production' }).where(eq(tenants.id, a));
    expect(
      await causeOf(db.insert(issuerEvents).values(cancel({ environment: 'production' }))),
    ).toContain('the document belongs to another environment');
  });
});
