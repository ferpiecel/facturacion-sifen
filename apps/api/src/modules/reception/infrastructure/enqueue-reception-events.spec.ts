import {
  createPgliteDatabase,
  tenants,
  webhookDeliveries,
  webhookEndpoints,
  withTenantTransaction,
  type DatabaseHandle,
} from '@sifen/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { rehydrateReceivedDocument } from '../domain/received-document.js';
import type { ReceptionEventType } from '../domain/reception-events.js';
import {
  enqueueReceptionEvents,
  receptionEventId,
  type EnqueueReceptionEventsInput,
} from './enqueue-reception-events.js';

const AT = new Date('2026-11-10T12:00:00.000Z');
const SEALED = {
  v: 1,
  keyId: 'k',
  wrappedKey: 'AA==',
  nonce: 'AA==',
  tag: 'AA==',
  ciphertext: 'AA==',
};
const DOC_ID = '5b3f0f4e-7a49-4b61-9a5e-3a1f2c9d8e10';

const document = (over: Partial<Parameters<typeof rehydrateReceivedDocument>[0]> = {}) =>
  rehydrateReceivedDocument({
    id: DOC_ID,
    tenantId: 'unused',
    source: 'sifen_xml',
    status: 'confirmed',
    version: 2,
    needsReview: false,
    needsReviewReasons: [],
    isOwnReceiver: true,
    confidenceOverall: '1.0',
    extractionAttempts: 0,
    confirmedAt: AT,
    ...over,
  });

/** Spec: reception R4.5 (ADR-0028). One delivery per matching endpoint, inside the caller's transaction. */
describe('enqueueReceptionEvents', () => {
  let handle: DatabaseHandle;
  let tenantId: string;

  beforeEach(async () => {
    handle = createPgliteDatabase();
    await handle.migrate();
    const [a] = await handle.db
      .insert(tenants)
      .values([{ name: 'A' }])
      .returning();
    tenantId = a.id;
  });
  afterEach(async () => {
    await handle.close();
  });

  const endpoint = async (over: Partial<typeof webhookEndpoints.$inferInsert> = {}) =>
    (
      await handle.db
        .insert(webhookEndpoints)
        .values({ tenantId, url: 'https://h.example.com/x', sealed: SEALED, ...over })
        .returning()
    )[0].id;
  const deliveries = () => handle.db.select().from(webhookDeliveries);
  const enqueue = (input: Partial<EnqueueReceptionEventsInput> & { types: ReceptionEventType[] }) =>
    withTenantTransaction(handle.db, tenantId, (tx) =>
      enqueueReceptionEvents(tx, {
        tenantId,
        document: document({ tenantId }),
        at: AT,
        ...input,
      }),
    );

  it('enqueues the minimal envelope: id, status, version and a link, no fiscal data', async () => {
    const ep = await endpoint();
    await enqueue({ types: ['reception.document.confirmed'] });
    const [row] = await deliveries();
    expect(row).toMatchObject({
      endpointId: ep,
      tenantId,
      eventType: 'reception.document.confirmed',
      status: 'pending',
      attemptCount: 0,
      nextAttemptAt: AT,
    });
    expect(row.eventId).toBe(receptionEventId(DOC_ID, 'reception.document.confirmed', 2));
    expect(row.payload).toEqual({
      id: row.eventId,
      type: 'reception.document.confirmed',
      created_at: AT.toISOString(),
      tenant_id: tenantId,
      data: {
        document_id: DOC_ID,
        status: 'confirmed',
        version: 2,
        links: { self: `/v1/received-documents/${DOC_ID}` },
      },
    });
  });

  it('adds the reason codes to needs_review and the actor to updated', async () => {
    await endpoint();
    await enqueue({
      types: ['reception.document.needs_review'],
      document: document({
        tenantId,
        status: 'needs_review',
        needsReview: true,
        needsReviewReasons: ['missing_issuer_ruc'],
        confirmedAt: null,
        version: 1,
      }),
    });
    await enqueue({
      types: ['reception.document.updated'],
      actor: { kind: 'api_key', id: 'key-1' },
    });
    const rows = await deliveries();
    const byType = Object.fromEntries(rows.map((r) => [r.eventType, r.payload])) as Record<
      string,
      { data: Record<string, unknown> }
    >;
    expect(byType['reception.document.needs_review'].data).toMatchObject({
      status: 'needs_review',
      reasons: ['missing_issuer_ruc'],
    });
    expect(byType['reception.document.updated'].data).toMatchObject({
      status: 'confirmed',
      version: 2,
      actor: { type: 'api_key', id: 'key-1' },
    });
    expect(byType['reception.document.updated'].data).not.toHaveProperty('reasons');
    expect(byType['reception.document.confirmed' as string]).toBeUndefined();
  });

  it.each([
    [{ kind: 'portal' }, { type: 'portal' }],
    [{ kind: 'system' }, { type: 'system' }],
  ] as const)('serialises the %o actor without an id', async (actor, expected) => {
    await endpoint();
    await enqueue({ types: ['reception.document.updated'], actor });
    const [row] = await deliveries();
    expect((row.payload as { data: { actor: unknown } }).data.actor).toEqual(expected);
  });

  it('is idempotent per document, type and version, and distinct for a later version', async () => {
    await endpoint();
    await enqueue({ types: ['reception.document.updated'], actor: { kind: 'system' } });
    await enqueue({ types: ['reception.document.updated'], actor: { kind: 'system' } });
    expect(await deliveries()).toHaveLength(1);
    await enqueue({
      types: ['reception.document.updated'],
      actor: { kind: 'system' },
      document: document({ tenantId, version: 3 }),
    });
    expect(await deliveries()).toHaveLength(2);
  });

  it('matches endpoint filters: empty = all, listed = only those; inactive endpoints are skipped', async () => {
    const all = await endpoint();
    const only = await endpoint({ events: ['reception.document.confirmed'] });
    await endpoint({ events: ['document.approved'] });
    await endpoint({ active: false });
    await enqueue({ types: ['reception.document.confirmed', 'reception.document.updated'] });
    const rows = await deliveries();
    expect(rows.filter((r) => r.endpointId === all)).toHaveLength(2);
    expect(rows.filter((r) => r.endpointId === only).map((r) => r.eventType)).toEqual([
      'reception.document.confirmed',
    ]);
    expect(rows).toHaveLength(3);
  });

  it('enqueues nothing for a document whose receiver is not the tenant, for any event type', async () => {
    await endpoint();
    await enqueue({
      types: [
        'reception.document.confirmed',
        'reception.document.needs_review',
        'reception.document.extraction_failed',
        'reception.document.updated',
      ],
      actor: { kind: 'system' },
      document: document({ tenantId, isOwnReceiver: false }),
    });
    expect(await deliveries()).toHaveLength(0);
  });

  it('does nothing without events or without endpoints', async () => {
    await enqueue({ types: [] });
    await enqueue({ types: ['reception.document.confirmed'] });
    expect(await deliveries()).toHaveLength(0);
  });
});
