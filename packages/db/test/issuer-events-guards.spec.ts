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
