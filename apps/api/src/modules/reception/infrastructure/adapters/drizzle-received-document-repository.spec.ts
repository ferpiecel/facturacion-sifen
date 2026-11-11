import { randomUUID } from 'node:crypto';
import {
  auditLog,
  createPgliteDatabase,
  receivedArtifacts,
  tenants,
  type DatabaseHandle,
} from '@sifen/db';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ReceivedDocumentNotFoundError,
  VersionConflictError,
  type FieldConfidence,
  type NewReceivedArtifact,
  type NewReceivedDocument,
  type ReceivedDocumentItem,
} from '../../application/ports/received-document-repository.port.js';
import {
  createReceivedDocument,
  rehydrateReceivedDocument,
  type ReceivedDocument,
} from '../../domain/received-document.js';
import { transitionReceivedDocument } from '../../domain/received-document.js';
import { createDrizzleReceivedDocumentRepository } from './drizzle-received-document-repository.js';

const CDC = '01800695631001001000000612021112917595714694';
const SHA = 'a'.repeat(64);
const AT = new Date('2026-11-06T12:00:00.000Z');
const BIG_MONEY = '1234567890123.12345678';

const item = (
  position: number,
  over: Partial<ReceivedDocumentItem> = {},
): ReceivedDocumentItem => ({
  position,
  description: `Item ${String(position)}`,
  productCode: `P-${String(position)}`,
  quantity: '2.50000000',
  unitOfMeasure: 'UNI',
  unitPrice: '1000.00000000',
  discount: '0.00000000',
  subtotal: '2500.00000000',
  vatRate: 10,
  taxableBase: '2272.72727273',
  vatAmount: '227.27272727',
  ...over,
});

const confidence = (fieldName: string, value: string): FieldConfidence => ({
  fieldName,
  confidence: value,
  extractedValue: 'x',
  correctedValue: null,
  correctedBy: null,
  correctedAt: null,
});

const artifact = (over: Partial<NewReceivedArtifact> = {}): NewReceivedArtifact => ({
  storageKey: `pdf/${randomUUID()}.pdf`,
  contentType: 'application/pdf',
  sha256: SHA,
  sizeBytes: 1234,
  originalName: 'factura.pdf',
  pageCount: 2,
  ...over,
});

/** Spec: reception R1.5. Repository over the received_* tables, run as app_user under forced RLS. */
describe('DrizzleReceivedDocumentRepository', () => {
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
  const fresh = (tenant = tenantId, source: ReceivedDocument['source'] = 'sifen_xml') =>
    createReceivedDocument({ id: randomUUID(), tenantId: tenant, source, isOwnReceiver: true });
  const fullGraph = (tenant = tenantId): NewReceivedDocument => ({
    document: fresh(tenant),
    header: {
      cdc: CDC,
      documentType: 1,
      issuerRucBase: '80069563',
      issuerRucDv: 1,
      issuerLegalName: 'Proveedor SA',
      issuedAt: AT,
      dueOn: '2026-12-06',
      paymentCondition: 'credit',
      totalAmount: BIG_MONEY,
      rawData: { rDE: { ok: true } },
    },
    items: [item(1), item(2, { vatRate: 5 })],
    confidences: [confidence('issuer_ruc', '0.990'), confidence('totals', '0.700')],
    artifact: artifact(),
  });

  it('saves and loads a full graph: header, two items, confidences and artifact', async () => {
    const input = fullGraph();
    const result = await repo().create(tenantId, input);
    expect(result.created).toBe(true);
    expect(result.document).toEqual(input.document);

    const graph = await repo().load(tenantId, input.document.id);
    expect(graph?.document).toEqual(input.document);
    expect(graph?.header).toMatchObject({
      cdc: CDC,
      documentType: 1,
      issuerRucBase: '80069563',
      issuerRucDv: 1,
      issuerLegalName: 'Proveedor SA',
      issuedAt: AT,
      dueOn: '2026-12-06',
      paymentCondition: 'credit',
      currency: 'PYG',
      sifenStatus: 'unknown',
      rawData: { rDE: { ok: true } },
      timbrado: null,
      confirmedBy: null,
    });
    expect(graph?.items).toEqual([item(1), item(2, { vatRate: 5 })]);
    expect(graph?.confidences.map((c) => [c.fieldName, c.confidence])).toEqual([
      ['issuer_ruc', '0.990'],
      ['totals', '0.700'],
    ]);
    expect(graph?.artifact).toMatchObject({ sha256: SHA, sizeBytes: 1234, pageCount: 2 });
    expect(graph?.artifact?.id).toEqual(expect.any(String));
  });

  it('round-trips money as exact decimal strings', async () => {
    const input = { ...fullGraph(), items: [item(1, { unitPrice: BIG_MONEY })] };
    await repo().create(tenantId, input);
    const graph = await repo().load(tenantId, input.document.id);
    expect(graph?.header.totalAmount).toBe(BIG_MONEY);
    expect(graph?.items[0].unitPrice).toBe(BIG_MONEY);
  });

  it('creates a bare document with no header, items or artifact', async () => {
    const document = fresh(tenantId, 'photo');
    expect((await repo().create(tenantId, { document })).created).toBe(true);
    const graph = await repo().load(tenantId, document.id);
    expect(graph).toMatchObject({ items: [], confidences: [], artifact: null });
    expect(graph?.header.cdc).toBeNull();
  });

  it('returns null for an unknown id', async () => {
    expect(await repo().load(tenantId, randomUUID())).toBeNull();
  });

  it('finds a document by CDC and an artifact by sha256 with its linked document', async () => {
    const input = fullGraph();
    await repo().create(tenantId, input);
    expect(await repo().findByCdc(tenantId, CDC)).toEqual(input.document);
    expect(await repo().findByCdc(tenantId, '1'.repeat(44))).toBeNull();
    const match = await repo().findArtifactBySha256(tenantId, SHA);
    expect(match?.document).toEqual(input.document);
    expect(match?.artifact.sha256).toBe(SHA);
    expect(await repo().findArtifactBySha256(tenantId, 'b'.repeat(64))).toBeNull();
  });

  it('returns the existing document, created=false, when the CDC is inserted again', async () => {
    const first = fullGraph();
    await repo().create(tenantId, first);
    const second = { ...fullGraph(), artifact: undefined };
    const result = await repo().create(tenantId, second);
    expect(result).toEqual({ created: false, document: first.document });
    expect(await repo().load(tenantId, second.document.id)).toBeNull();
  });

  it('returns the existing document, created=false, when the artifact sha256 is already attached', async () => {
    const first = fullGraph();
    await repo().create(tenantId, first);
    const second: NewReceivedDocument = {
      document: fresh(tenantId, 'pdf'),
      artifact: artifact({ storageKey: 'pdf/other.pdf' }),
    };
    const result = await repo().create(tenantId, second);
    expect(result).toEqual({ created: false, document: first.document });
    expect(await repo().load(tenantId, second.document.id)).toBeNull();
  });

  it('attaches a new document to a stored artifact that no document references yet', async () => {
    // Ingest stores the upload first; a parser failure can leave the artifact without a document.
    const lone = artifact({ sha256: 'c'.repeat(64), storageKey: 'pdf/lone.pdf' });
    await handle.db.insert(receivedArtifacts).values({ ...lone, tenantId });
    expect((await repo().findArtifactBySha256(tenantId, lone.sha256))?.document).toBeNull();

    const document = fresh(tenantId, 'pdf');
    const result = await repo().create(tenantId, { document, artifact: lone });
    expect(result).toEqual({ created: true, document });
    const graph = await repo().load(tenantId, document.id);
    expect(graph?.artifact?.sha256).toBe(lone.sha256);
  });

  it('dedupes on issuer, timbrado and document number when there is no CDC', async () => {
    const header = {
      issuerRucBase: '80069563',
      timbrado: '12345678',
      documentNumber: '0000612',
    };
    const first = { document: fresh(tenantId, 'pdf'), header };
    await repo().create(tenantId, first);
    const result = await repo().create(tenantId, { document: fresh(tenantId, 'photo'), header });
    expect(result).toEqual({ created: false, document: first.document });
  });

  it('keeps tenants apart and lets another tenant store the same CDC and sha256', async () => {
    const mine = fullGraph();
    await repo().create(tenantId, mine);

    expect(await repo().load(otherTenantId, mine.document.id)).toBeNull();
    expect(await repo().findByCdc(otherTenantId, CDC)).toBeNull();
    expect(await repo().findArtifactBySha256(otherTenantId, SHA)).toBeNull();

    const theirs = fullGraph(otherTenantId);
    const result = await repo().create(otherTenantId, theirs);
    expect(result).toEqual({ created: true, document: theirs.document });
    expect((await repo().findByCdc(tenantId, CDC))?.id).toBe(mine.document.id);
    expect((await repo().findByCdc(otherTenantId, CDC))?.id).toBe(theirs.document.id);
  });

  it('rejects a document built for another tenant than the call', async () => {
    await expect(repo().create(tenantId, { document: fresh(otherTenantId) })).rejects.toThrow(
      /tenant/i,
    );
  });

  it('persists transitions through the aggregate: received -> extracted -> confirmed ends at version 2', async () => {
    const { document } = await repo().create(tenantId, fullGraph());
    const extracted = transitionReceivedDocument(document, 'extracted', {
      at: AT,
      confidenceOverall: '0.950',
    }).document;
    await repo().save(tenantId, extracted, document.version);
    const confirmed = transitionReceivedDocument(extracted, 'confirmed', { at: AT }).document;
    await repo().save(tenantId, confirmed, extracted.version, { header: { confirmedBy: 'key-1' } });

    expect(confirmed.version).toBe(2);
    const graph = await repo().load(tenantId, document.id);
    expect(graph?.document).toEqual(confirmed);
    expect(graph?.header.confirmedBy).toBe('key-1');
  });

  it('persists needs_review reasons and extraction attempts', async () => {
    const { document } = await repo().create(tenantId, { document: fresh(tenantId, 'pdf') });
    const extracting = transitionReceivedDocument(document, 'extracting', { at: AT }).document;
    await repo().save(tenantId, extracting, document.version);
    const failed = transitionReceivedDocument(extracting, 'extraction_failed', { at: AT }).document;
    await repo().save(tenantId, failed, extracting.version, {
      header: { extractionErrorCode: 'llm_timeout' },
    });
    const graph = await repo().load(tenantId, document.id);
    expect(graph?.document).toEqual(failed);
    expect(graph?.document.extractionAttempts).toBe(1);
    expect(graph?.header.extractionErrorCode).toBe('llm_timeout');
  });

  it('rejects a stale expected version with VersionConflictError and writes nothing', async () => {
    const { document } = await repo().create(tenantId, fullGraph());
    const extracted = transitionReceivedDocument(document, 'extracted', { at: AT }).document;
    const confirmed = transitionReceivedDocument(extracted, 'confirmed', { at: AT }).document;
    await repo().save(tenantId, extracted, document.version);
    await repo().save(tenantId, confirmed, extracted.version);

    // A second writer still holds version 1 and tries to move the document elsewhere.
    const stale = transitionReceivedDocument(extracted, 'needs_review', {
      at: AT,
      reasons: ['low_confidence'],
    }).document;
    await expect(
      repo().save(tenantId, stale, document.version, { header: { confirmedBy: 'late' } }),
    ).rejects.toBeInstanceOf(VersionConflictError);

    const graph = await repo().load(tenantId, document.id);
    expect(graph?.document).toEqual(confirmed);
    expect(graph?.header.confirmedBy).toBeNull();
  });

  it('reports a missing document and never touches another tenant', async () => {
    const { document } = await repo().create(tenantId, fullGraph());
    const extracted = transitionReceivedDocument(document, 'extracted', { at: AT }).document;
    await expect(repo().save(otherTenantId, extracted, document.version)).rejects.toBeInstanceOf(
      ReceivedDocumentNotFoundError,
    );
    expect((await repo().load(tenantId, document.id))?.document.status).toBe('received');
  });

  describe('saveExtraction', () => {
    const extractedGraph = async () => {
      const { document } = await repo().create(tenantId, {
        document: fresh(tenantId, 'pdf'),
        artifact: artifact(),
      });
      const extracting = transitionReceivedDocument(document, 'extracting', { at: AT }).document;
      await repo().save(tenantId, extracting, document.version);
      const extracted = transitionReceivedDocument(extracting, 'extracted', { at: AT }).document;
      const review = transitionReceivedDocument(extracted, 'needs_review', {
        at: AT,
        reasons: ['low_confidence'],
        confidenceOverall: '0.500',
      }).document;
      return { extracting, review };
    };

    it('writes state, receiver flag, header, items and confidences in one go', async () => {
      const { extracting, review } = await extractedGraph();
      const notOwn = rehydrateReceivedDocument({ ...review, isOwnReceiver: false });
      await repo().saveExtraction(tenantId, {
        document: notOwn,
        expectedVersion: extracting.version,
        header: { issuerLegalName: 'Proveedor SA', extractionErrorCode: null, rawData: { a: 1 } },
        items: [item(1), item(2)],
        confidences: [confidence('totals', '0.700')],
      });
      const graph = await repo().load(tenantId, extracting.id);
      expect(graph?.document).toEqual(notOwn);
      expect(graph?.header).toMatchObject({ issuerLegalName: 'Proveedor SA', rawData: { a: 1 } });
      expect(graph?.items).toEqual([item(1), item(2)]);
      expect(graph?.confidences.map((c) => c.fieldName)).toEqual(['totals']);
    });

    it('is safe to repeat: items and confidences are upserted, not duplicated', async () => {
      const { extracting, review } = await extractedGraph();
      const write = {
        document: review,
        expectedVersion: extracting.version,
        header: {},
        items: [item(1)],
        confidences: [confidence('totals', '0.700')],
      };
      await repo().saveExtraction(tenantId, write);
      await repo().saveExtraction(tenantId, {
        ...write,
        items: [item(1, { description: 'Changed' })],
        confidences: [confidence('totals', '0.800')],
      });
      const graph = await repo().load(tenantId, extracting.id);
      expect(graph?.items).toEqual([item(1, { description: 'Changed' })]);
      expect(graph?.confidences.map((c) => c.confidence)).toEqual(['0.800']);
    });

    it('soft-removes surplus items when a repeated write carries fewer', async () => {
      const { extracting, review } = await extractedGraph();
      const write = {
        document: review,
        expectedVersion: extracting.version,
        header: {},
        items: [item(1), item(2), item(3)],
        confidences: [confidence('totals', '0.700')],
      };
      await repo().saveExtraction(tenantId, write);
      await repo().saveExtraction(tenantId, { ...write, items: [item(1)] });
      const graph = await repo().load(tenantId, extracting.id);
      expect(graph?.items).toEqual([item(1)]);
      expect(graph?.removedPositions).toEqual([2, 3]);
    });

    it('soft-removes every earlier item when the repeated write has none', async () => {
      const { extracting, review } = await extractedGraph();
      const write = {
        document: review,
        expectedVersion: extracting.version,
        header: {},
        items: [item(1), item(2)],
        confidences: [],
      };
      await repo().saveExtraction(tenantId, write);
      await repo().saveExtraction(tenantId, { ...write, items: [] });
      const graph = await repo().load(tenantId, extracting.id);
      expect(graph?.items).toEqual([]);
      expect(graph?.removedPositions).toEqual([1, 2]);
    });

    it('never reuses a soft-removed position: it numbers the later items past the highest one', async () => {
      const { extracting, review } = await extractedGraph();
      const write = {
        document: review,
        expectedVersion: extracting.version,
        header: {},
        items: [item(1), item(2), item(3)],
        confidences: [],
      };
      await repo().saveExtraction(tenantId, write);
      await repo().saveExtraction(tenantId, { ...write, items: [item(1)] });
      // Positions 2 and 3 are frozen by the removal guard (migration 0081): a reprocess that reads
      // three lines again must not touch them.
      await repo().saveExtraction(tenantId, {
        ...write,
        items: [item(1), item(2, { description: 'B' }), item(3, { description: 'C' })],
      });
      const graph = await repo().load(tenantId, extracting.id);
      expect(graph?.items.map((i) => [i.position, i.description])).toEqual([
        [1, item(1).description],
        [4, 'B'],
        [5, 'C'],
      ]);
      expect(graph?.removedPositions).toEqual([2, 3]);
    });

    it('leaves the stored items untouched when they are a human override', async () => {
      const { extracting, review } = await extractedGraph();
      const write = {
        document: review,
        expectedVersion: extracting.version,
        header: {},
        items: [item(1), item(2), item(3)],
        confidences: [confidence('totals', '0.700')],
      };
      await repo().saveExtraction(tenantId, write);
      // Position 3 is soft-removed (as a person's correction would leave it).
      await repo().saveExtraction(tenantId, { ...write, items: [item(1), item(2)] });

      await repo().saveExtraction(tenantId, {
        ...write,
        items: [item(1, { description: 'machine' })],
        keepItems: true,
      });

      const graph = await repo().load(tenantId, extracting.id);
      expect(graph?.items).toEqual([item(1), item(2)]);
      expect(graph?.removedPositions).toEqual([3]);
    });

    it('keeps corrected_* on a confidence row while refreshing what the machine reads', async () => {
      const { extracting, review } = await extractedGraph();
      const humanAt = new Date('2026-11-09T10:00:00.000Z');
      const write = {
        document: review,
        expectedVersion: extracting.version,
        header: {},
        items: [],
        confidences: [
          {
            ...confidence('totals', '0.700'),
            correctedValue: '110',
            correctedBy: 'key-1',
            correctedAt: humanAt,
          },
        ],
      };
      await repo().saveExtraction(tenantId, write);
      await repo().saveExtraction(tenantId, {
        ...write,
        confidences: [
          {
            ...write.confidences[0],
            confidence: '0.400',
            extractedValue: 'new reading',
          },
        ],
      });

      const row = (await repo().load(tenantId, extracting.id))?.confidences[0];
      expect(row).toMatchObject({
        confidence: '0.400',
        extractedValue: 'new reading',
        correctedValue: '110',
        correctedBy: 'key-1',
        correctedAt: humanAt,
      });
    });

    it('survives a confirmed -> extracting -> confirmed round trip keeping the first confirmedAt', async () => {
      const { extracting } = await extractedGraph();
      const first = transitionReceivedDocument(
        transitionReceivedDocument(extracting, 'extracted', { at: AT }).document,
        'confirmed',
        { at: AT },
      );
      await repo().saveExtraction(tenantId, {
        document: first.document,
        expectedVersion: extracting.version,
        header: {},
        items: [],
        confidences: [],
      });
      const later = new Date('2026-11-12T09:00:00.000Z');
      const again = transitionReceivedDocument(first.document, 'extracting', { at: later });
      await repo().save(tenantId, again.document, first.document.version);
      expect((await repo().load(tenantId, extracting.id))?.document).toMatchObject({
        status: 'extracting',
        confirmedAt: AT,
        version: first.document.version + 1,
      });

      const review = transitionReceivedDocument(
        transitionReceivedDocument(again.document, 'extracted', { at: later }).document,
        'needs_review',
        { at: later, reasons: ['low_confidence'] },
      );
      await repo().saveExtraction(tenantId, {
        document: review.document,
        expectedVersion: again.document.version,
        header: {},
        items: [],
        confidences: [],
      });
      const stored = (await repo().load(tenantId, extracting.id))?.document;
      expect(stored).toMatchObject({ status: 'needs_review', confirmedAt: AT });
    });

    it('rejects a stale version and reports a missing document', async () => {
      const { extracting, review } = await extractedGraph();
      const base = { document: review, header: {}, items: [], confidences: [] };
      await expect(
        repo().saveExtraction(tenantId, { ...base, expectedVersion: 99 }),
      ).rejects.toBeInstanceOf(VersionConflictError);
      await expect(
        repo().saveExtraction(otherTenantId, { ...base, expectedVersion: extracting.version }),
      ).rejects.toBeInstanceOf(ReceivedDocumentNotFoundError);
      expect((await repo().load(tenantId, extracting.id))?.document.status).toBe('extracting');
    });
  });

  describe('appendAudit', () => {
    it('appends one audit entry for the document and rejects another tenant', async () => {
      const { document } = await repo().create(tenantId, fullGraph());
      await repo().appendAudit(tenantId, {
        documentId: document.id,
        actor: { type: 'api_key', id: 'key-1' },
        action: 'received_document.reprocess_requested',
        before: { status: 'received' },
        after: { queued: true },
      });
      const rows = await handle.db
        .select()
        .from(auditLog)
        .where(eq(auditLog.entityId, document.id));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        action: 'received_document.reprocess_requested',
        entityType: 'received_document',
        actorType: 'api_key',
        actorId: 'key-1',
      });
      await repo().appendAudit(tenantId, {
        documentId: document.id,
        actor: { type: 'user', id: 'user-1' },
        action: 'received_document.reprocess_requested',
        before: {},
        after: {},
      });
      const all = await handle.db.select().from(auditLog).where(eq(auditLog.entityId, document.id));
      expect(all.map((row) => row.actorType).sort()).toEqual(['api_key', 'user']);
      await expect(
        repo().appendAudit(otherTenantId, {
          documentId: document.id,
          actor: { type: 'api_key', id: 'key-1' },
          action: 'x',
          before: {},
          after: {},
        }),
      ).rejects.toBeInstanceOf(ReceivedDocumentNotFoundError);
    });
  });
});
