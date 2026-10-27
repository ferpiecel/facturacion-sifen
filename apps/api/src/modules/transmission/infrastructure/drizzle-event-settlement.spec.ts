import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  auditLog,
  createPgliteDatabase,
  documents,
  issuerEvents,
  tenants,
  webhookDeliveries,
  type DatabaseHandle,
} from '@sifen/db';
import { seedDocuments, seedWebhookEndpoint } from '../../../../test/support/document-seed.js';
import { createDrizzleEventBatchStore } from './drizzle-event-batch-store.js';

const NOW = new Date('2026-10-17T12:00:00.000Z');
const NOMINATION = {
  kind: 'taxpayer',
  ruc: '80012345-1',
  taxpayerType: 2,
  name: 'Cliente SA',
  country: 'PRY',
  operationType: 'B2B',
};
const RANGE = { timbrado: '12345678', establishment: '001', point: '001', from: 1, to: 5, type: 1 };

/** Spec: HU-E8-04 (slice D). What settling an issuer event leaves behind: audit, document status, webhooks. */
describe('settling issuer events', () => {
  let handle: DatabaseHandle;
  let tenantId: string;
  let seq = 0;

  beforeEach(async () => {
    seq = 0;
    handle = createPgliteDatabase();
    await handle.migrate();
    const [tenant] = await handle.db.insert(tenants).values({ name: 'A' }).returning();
    tenantId = tenant.id;
  });

  afterEach(async () => {
    await handle.close();
  });

  const warnings: string[] = [];
  const store = () =>
    createDrizzleEventBatchStore({
      db: handle.db,
      tenantId,
      now: () => NOW,
      logger: { warn: (message) => warnings.push(message) },
    });

  /** A cancellation (or voiding) in `sending`, ready to be settled. */
  async function sending(documentId: string | null) {
    seq += 1;
    const [row] = await handle.db
      .insert(issuerEvents)
      .values({
        tenantId,
        environment: 'test',
        kind: documentId ? 'cancellation' : 'voiding',
        eventId: BigInt(seq),
        reason: 'Error en los datos',
        ...(documentId ? { documentId } : { voidRange: RANGE }),
      })
      .returning();
    await handle.db
      .update(issuerEvents)
      .set({ status: 'signed', signedXml: '<a/>', signedAt: NOW })
      .where(eq(issuerEvents.id, row.id));
    await handle.db
      .update(issuerEvents)
      .set({ status: 'sending', batchDId: 3n, sendAttemptedAt: NOW })
      .where(eq(issuerEvents.id, row.id));
    return row.id;
  }

  const statusOf = async (id: string) =>
    (await handle.db.select().from(documents).where(eq(documents.id, id)))[0].status;
  const approved = { status: 'approved', code: '0600', message: 'ok' } as const;

  it.each(['approved', 'approved_with_observations'])(
    'cancels a %s document when its cancellation is approved, and queues document.cancelled',
    async (documentStatus) => {
      const [doc] = await seedDocuments(handle.db, tenantId, [documentStatus]);
      await seedWebhookEndpoint(handle.db, tenantId);
      const id = await sending(doc.id);

      await store().record(new Map([[id, approved]]));

      expect(await statusOf(doc.id)).toBe('cancelled');
      const deliveries = await handle.db.select().from(webhookDeliveries);
      expect(deliveries.map((d) => d.eventType)).toEqual(['document.cancelled']);
      const audits = await handle.db.select().from(auditLog);
      expect(audits.map((a) => a.action).sort()).toEqual([
        'document.cancelled',
        'issuer_event.approved',
      ]);
    },
  );

  async function sendingNomination(documentId: string) {
    seq += 1;
    const [row] = await handle.db
      .insert(issuerEvents)
      .values({
        tenantId,
        environment: 'test',
        kind: 'nomination',
        eventId: BigInt(seq),
        reason: 'Cliente identificado',
        documentId,
        nomination: NOMINATION,
      })
      .returning();
    await handle.db
      .update(issuerEvents)
      .set({ status: 'signed', signedXml: '<a/>', signedAt: NOW })
      .where(eq(issuerEvents.id, row.id));
    await handle.db
      .update(issuerEvents)
      .set({ status: 'sending', batchDId: 3n, sendAttemptedAt: NOW })
      .where(eq(issuerEvents.id, row.id));
    return row.id;
  }

  it('queues document.nominated when a nomination is approved, leaving the document approved', async () => {
    const [doc] = await seedDocuments(handle.db, tenantId, ['approved']);
    await seedWebhookEndpoint(handle.db, tenantId);
    const id = await sendingNomination(doc.id);

    await store().record(new Map([[id, approved]]));

    expect(await statusOf(doc.id)).toBe('approved');
    const deliveries = await handle.db.select().from(webhookDeliveries);
    expect(deliveries.map((d) => d.eventType)).toEqual(['document.nominated']);
    expect(deliveries[0].payload).toMatchObject({
      type: 'document.nominated',
      data: { document_id: doc.id, status: 'approved' },
    });
  });

  it('queues no webhook for a rejected nomination', async () => {
    const [doc] = await seedDocuments(handle.db, tenantId, ['approved']);
    await seedWebhookEndpoint(handle.db, tenantId);
    const id = await sendingNomination(doc.id);

    await store().record(new Map([[id, { status: 'rejected', code: '4453', message: 'dup' }]]));

    expect(await handle.db.select().from(webhookDeliveries)).toEqual([]);
  });

  it('leaves a document alone when it is no longer cancellable, and still settles the event', async () => {
    const [doc] = await seedDocuments(handle.db, tenantId, ['rejected']);
    const id = await sending(doc.id);

    await store().record(new Map([[id, approved]]));

    expect(await statusOf(doc.id)).toBe('rejected');
    expect(
      (await handle.db.select().from(issuerEvents).where(eq(issuerEvents.id, id)))[0].status,
    ).toBe('approved');
    // Not silent: an approved cancellation of a document that cannot be cancelled is for an operator.
    expect(warnings).toEqual([expect.stringContaining(id)]);
    expect(warnings[0]).toContain(doc.id);
    expect(warnings[0]).toContain('rejected');
  });

  it('audits a rejection and an unknown outcome without touching the document', async () => {
    const [a, b] = await seedDocuments(handle.db, tenantId, ['approved', 'approved']);
    const first = await sending(a.id);
    const second = await sending(b.id);

    await store().record(
      new Map([
        [first, { status: 'rejected', code: '4009', message: 'late' }],
        [second, { status: 'unknown', reason: 'timed out' }],
      ]),
    );

    expect(await statusOf(a.id)).toBe('approved');
    expect(await statusOf(b.id)).toBe('approved');
    const audits = await handle.db.select().from(auditLog);
    expect(audits.map((x) => x.action).sort()).toEqual([
      'issuer_event.rejected',
      'issuer_event.unknown',
    ]);
    expect(audits.find((x) => x.action === 'issuer_event.rejected')).toMatchObject({
      entityType: 'issuer_event',
      entityId: first,
      actorType: 'system',
      after: { status: 'rejected', responseCode: '4009' },
    });
  });

  it('approves a voiding without touching any document (E8-03 settles numbers)', async () => {
    const [doc] = await seedDocuments(handle.db, tenantId, ['approved']);
    const id = await sending(null);

    await store().record(new Map([[id, approved]]));

    expect(await statusOf(doc.id)).toBe('approved');
    expect((await handle.db.select().from(auditLog)).map((a) => a.action)).toEqual([
      'issuer_event.approved',
    ]);
  });

  it('moves the rejected documents of an approved voiding to number_voided and queues the webhook', async () => {
    const docs = await seedDocuments(
      handle.db,
      tenantId,
      ['rejected', 'approved', 'rejected', 'rejected'],
      (i) => (i === 3 ? { number: 9, cdc: '9'.repeat(44) } : {}),
    );
    await seedWebhookEndpoint(handle.db, tenantId);
    const id = await sending(null);

    await store().record(new Map([[id, approved]]));

    expect(await Promise.all(docs.map((d) => statusOf(d.id)))).toEqual([
      'number_voided',
      'approved',
      'number_voided',
      'rejected',
    ]);
    const deliveries = await handle.db.select().from(webhookDeliveries);
    expect(deliveries.map((d) => d.eventType)).toEqual([
      'document.number_voided',
      'document.number_voided',
    ]);
    const audits = (await handle.db.select().from(auditLog)).map((a) => a.action);
    expect(audits.filter((a) => a === 'document.number_voided')).toHaveLength(2);
  });

  it('settles a voiding of numbers that have no document', async () => {
    const id = await sending(null);

    await store().record(new Map([[id, approved]]));

    expect((await handle.db.select().from(auditLog)).map((a) => a.action)).toEqual([
      'issuer_event.approved',
    ]);
  });

  it('audits a local rejection of an unsent event', async () => {
    const [doc] = await seedDocuments(handle.db, tenantId, ['approved']);
    const [row] = await handle.db
      .insert(issuerEvents)
      .values({
        tenantId,
        environment: 'test',
        kind: 'cancellation',
        eventId: 99n,
        documentId: doc.id,
        reason: 'Error en los datos',
      })
      .returning();
    await handle.db
      .update(issuerEvents)
      .set({ status: 'signed', signedXml: '<a/>', signedAt: NOW })
      .where(eq(issuerEvents.id, row.id));

    await store().rejectUnsent(new Map([[row.id, { code: 'LOC-XSD', message: 'not valid' }]]));

    const audits = await handle.db.select().from(auditLog);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: 'issuer_event.rejected',
      after: { responseCode: 'LOC-XSD' },
    });
  });
});
