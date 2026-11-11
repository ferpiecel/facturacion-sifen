import { randomUUID } from 'node:crypto';
import {
  createPgliteDatabase,
  tenants,
  webhookDeliveries,
  webhookEndpoints,
  type DatabaseHandle,
} from '@sifen/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { VersionConflictError } from '../../application/ports/received-document-repository.port.js';
import {
  createReceivedDocument,
  transitionReceivedDocument,
} from '../../domain/received-document.js';
import { createDrizzleReceivedDocumentRepository } from './drizzle-received-document-repository.js';

const AT = new Date('2026-11-10T12:00:00.000Z');
const SEALED = {
  v: 1,
  keyId: 'k',
  wrappedKey: 'AA==',
  nonce: 'AA==',
  tag: 'AA==',
  ciphertext: 'AA==',
};

/** Spec: reception R4.5 (ADR-0028). Events are enqueued in the transaction of the state change. */
describe('DrizzleReceivedDocumentRepository event outbox', () => {
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
    await handle.db
      .insert(webhookEndpoints)
      .values({ tenantId, url: 'https://h.example.com/x', sealed: SEALED });
  });
  afterEach(async () => {
    await handle.close();
  });

  const repo = () => createDrizzleReceivedDocumentRepository(handle.db);
  const deliveries = () => handle.db.select().from(webhookDeliveries);
  const confirmed = (isOwnReceiver = true) => {
    const base = createReceivedDocument({
      id: randomUUID(),
      tenantId,
      source: 'sifen_xml',
      isOwnReceiver,
    });
    const extracted = transitionReceivedDocument(base, 'extracted', { at: AT }).document;
    return transitionReceivedDocument(extracted, 'confirmed', { at: AT }).document;
  };

  it('create enqueues the requested events with the document, once', async () => {
    const document = confirmed();
    const events = { types: ['reception.document.confirmed'] as const, at: AT };
    const header = { cdc: '01'.repeat(22) };
    await repo().create(tenantId, { document, header, events });
    // The same CDC again is a duplicate: nothing is written, nothing is enqueued.
    const again = await repo().create(tenantId, { document: confirmed(), header, events });
    expect(again.created).toBe(false);
    expect(await deliveries()).toHaveLength(1);
  });

  it('create enqueues nothing for a document that is not addressed to the tenant', async () => {
    await repo().create(tenantId, {
      document: confirmed(false),
      events: { types: ['reception.document.confirmed'], at: AT },
    });
    expect(await deliveries()).toHaveLength(0);
  });

  it('save enqueues with the state change and nothing when the version check fails', async () => {
    const document = confirmed();
    await repo().create(tenantId, { document });
    const edited = transitionReceivedDocument(document, 'confirmed', { at: AT });
    const events = {
      types: ['reception.document.updated'] as const,
      actor: { kind: 'system' } as const,
      at: AT,
    };
    await expect(
      repo().save(tenantId, edited.document, document.version + 5, { events }),
    ).rejects.toBeInstanceOf(VersionConflictError);
    expect(await deliveries()).toHaveLength(0);
    await repo().save(tenantId, edited.document, document.version, { events });
    const [row] = await deliveries();
    expect(row.eventType).toBe('reception.document.updated');
    expect((row.payload as { data: { version: number } }).data.version).toBe(
      edited.document.version,
    );
  });

  it('saveCorrection enqueues in its transaction; a failing write leaves no delivery', async () => {
    const document = confirmed();
    await repo().create(tenantId, { document });
    const edited = transitionReceivedDocument(document, 'confirmed', { at: AT }).document;
    const write = (expectedVersion: number) => ({
      document: edited,
      expectedVersion,
      items: { upserts: [], removedPositions: [] },
      confidences: [],
      actorId: 'key-1',
      at: AT,
      audit: { action: 'received_document.corrected', before: {}, after: {} },
      events: {
        types: ['reception.document.updated'] as const,
        actor: { kind: 'api_key', id: 'key-1' } as const,
        at: AT,
      },
    });
    await expect(repo().saveCorrection(tenantId, write(99))).rejects.toBeInstanceOf(
      VersionConflictError,
    );
    expect(await deliveries()).toHaveLength(0);
    await repo().saveCorrection(tenantId, write(document.version));
    expect(await deliveries()).toHaveLength(1);
  });
});
