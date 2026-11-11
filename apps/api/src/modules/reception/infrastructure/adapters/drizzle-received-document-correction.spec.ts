import { randomUUID } from 'node:crypto';
import {
  auditLog,
  createPgliteDatabase,
  receivedDocumentItems,
  tenants,
  type DatabaseHandle,
} from '@sifen/db';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ReceivedDocumentNotFoundError,
  VersionConflictError,
  type CorrectionWrite,
  type FieldConfidence,
  type ReceivedDocumentItem,
} from '../../application/ports/received-document-repository.port.js';
import {
  createReceivedDocument,
  recordReceivedDocumentCorrection,
  transitionReceivedDocument,
} from '../../domain/received-document.js';
import { createDrizzleReceivedDocumentRepository } from './drizzle-received-document-repository.js';

const AT = new Date('2026-11-10T12:00:00.000Z');

const item = (position: number, subtotal = '1000'): ReceivedDocumentItem => ({
  position,
  description: `Item ${String(position)}`,
  productCode: null,
  quantity: '1',
  unitOfMeasure: null,
  unitPrice: subtotal,
  discount: null,
  subtotal,
  vatRate: 10,
  taxableBase: null,
  vatAmount: null,
});

const confidence = (fieldName: string): FieldConfidence => ({
  fieldName,
  confidence: '1.000',
  extractedValue: 'old',
  correctedValue: null,
  correctedBy: null,
  correctedAt: null,
});

/** Spec: reception R4.4. Atomic correction writes and soft removal reads. */
describe('DrizzleReceivedDocumentRepository.saveCorrection', () => {
  let handle: DatabaseHandle;
  let tenantId: string;
  let otherTenantId: string;

  beforeEach(async () => {
    handle = createPgliteDatabase();
    await handle.migrate();
    const [a, b] = await handle.db
      .insert(tenants)
      .values([{ name: 'A' }, { name: 'B' }])
      .returning();
    [tenantId, otherTenantId] = [a.id, b.id];
  });
  afterEach(async () => {
    await handle.close();
  });

  const repo = () => createDrizzleReceivedDocumentRepository(handle.db);

  async function seed() {
    const base = createReceivedDocument({
      id: randomUUID(),
      tenantId,
      source: 'sifen_xml',
      isOwnReceiver: true,
    });
    const extracted = transitionReceivedDocument(base, 'extracted', { at: AT }).document;
    const document = transitionReceivedDocument(extracted, 'needs_review', {
      at: AT,
      reasons: ['totals_blocks_sum_mismatch'],
    }).document;
    await repo().create(tenantId, {
      document,
      header: { issuerLegalName: 'ACME', totalAmount: '100' },
      items: [item(1), item(2)],
      confidences: [confidence('issuer_legal_name'), confidence('totals'), confidence('items')],
    });
    return document;
  }

  const write = (
    document: Awaited<ReturnType<typeof seed>>,
    over: Partial<CorrectionWrite> = {},
  ): CorrectionWrite => ({
    document: recordReceivedDocumentCorrection(document, ['vat10_inconsistent']),
    expectedVersion: document.version,
    header: { issuerLegalName: 'ACME SA', correctedBy: 'key-1', correctedAt: AT },
    items: { upserts: [], removedPositions: [] },
    confidences: [],
    actorId: 'key-1',
    at: AT,
    audit: { action: 'received_document.corrected', before: { a: 1 }, after: { a: 2 } },
    ...over,
  });

  it('writes state, header, items, confidences and one audit entry together', async () => {
    const document = await seed();
    await repo().saveCorrection(
      tenantId,
      write(document, {
        items: { upserts: [item(1, '1500'), item(3, '700')], removedPositions: [2] },
        confidences: [
          { fieldName: 'issuer_legal_name', correctedValue: 'ACME SA' },
          { fieldName: 'items', correctedValue: '{}' },
          { fieldName: 'receiver_ruc', correctedValue: 'no row, skipped' },
        ],
      }),
    );
    const graph = await repo().load(tenantId, document.id);
    expect(graph?.document).toMatchObject({
      version: 2,
      needsReviewReasons: ['vat10_inconsistent'],
    });
    expect(graph?.header).toMatchObject({
      issuerLegalName: 'ACME SA',
      correctedBy: 'key-1',
      correctedAt: AT,
    });
    expect(graph?.items.map((i) => [i.position, i.subtotal])).toEqual([
      [1, '1500.00000000'],
      [3, '700.00000000'],
    ]);
    expect(graph?.removedPositions).toEqual([2]);
    const byField = Object.fromEntries(graph?.confidences.map((c) => [c.fieldName, c]) ?? []);
    expect(byField.issuer_legal_name).toMatchObject({
      correctedValue: 'ACME SA',
      correctedBy: 'key-1',
      extractedValue: 'old',
    });
    expect(byField.items.correctedAt).toEqual(AT);
    expect(byField.totals.correctedBy).toBeNull();
    expect(Object.keys(byField)).not.toContain('receiver_ruc');

    const audit = await handle.db.select().from(auditLog).where(eq(auditLog.entityId, document.id));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      tenantId,
      actorType: 'api_key',
      actorId: 'key-1',
      action: 'received_document.corrected',
      entityType: 'received_document',
    });
  });

  it('keeps removed items in the table but out of the loaded graph', async () => {
    const document = await seed();
    await repo().saveCorrection(
      tenantId,
      write(document, { items: { upserts: [], removedPositions: [1] } }),
    );
    const rows = await handle.db.select().from(receivedDocumentItems);
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.position === 1)).toMatchObject({
      removedBy: 'key-1',
      removedAt: AT,
    });
    expect((await repo().load(tenantId, document.id))?.items.map((i) => i.position)).toEqual([2]);
  });

  it('rolls everything back on a stale version: no item, header or audit write', async () => {
    const document = await seed();
    const failure = await repo()
      .saveCorrection(
        tenantId,
        write(document, {
          expectedVersion: 99,
          items: { upserts: [item(1, '9')], removedPositions: [2] },
        }),
      )
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(VersionConflictError);
    expect((failure as VersionConflictError).currentVersion).toBe(document.version);
    const graph = await repo().load(tenantId, document.id);
    expect(graph?.items).toHaveLength(2);
    expect(graph?.header.issuerLegalName).toBe('ACME');
    expect(await handle.db.select().from(auditLog)).toHaveLength(0);
  });

  it('rolls back the state write when a later item write fails', async () => {
    const document = await seed();
    await handle.db
      .update(receivedDocumentItems)
      .set({ removedAt: AT, removedBy: 'x' })
      .where(eq(receivedDocumentItems.position, 2));
    await expect(
      repo().saveCorrection(
        tenantId,
        write(document, { items: { upserts: [item(2, '5')], removedPositions: [] } }),
      ),
    ).rejects.toThrow();
    const graph = await repo().load(tenantId, document.id);
    expect(graph?.document.version).toBe(document.version);
    expect(graph?.header.issuerLegalName).toBe('ACME');
  });

  it('does not see or write another tenant document', async () => {
    const document = await seed();
    await expect(repo().saveCorrection(otherTenantId, write(document))).rejects.toBeInstanceOf(
      ReceivedDocumentNotFoundError,
    );
    expect(await repo().load(otherTenantId, document.id)).toBeNull();
  });
});
